export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    // Handle CORS for browser requests
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": "application/json"
    };

    // --- 1. SEARCH ENDPOINT ---
    if (request.method === "GET" && url.pathname === "/search") {
      const query = url.searchParams.get("q");
      const biennium = url.searchParams.get("biennium") || "2025-26";

      if (!query) return new Response(JSON.stringify({ error: "Missing query" }), { status: 400, headers: corsHeaders });

      try {
        const ftsQuery = `"${query.replace(/"/g, '""')}"`; 
        
        const sql = `
          SELECT 
            bill_number, 
            snippet(bill_texts, 2, '<mark class="bg-yellow-200 text-gray-900 font-bold px-1 rounded">', '</mark>', '...', 60) as match_snippet
          FROM bill_texts 
          WHERE biennium = ? AND bill_texts MATCH ? 
          ORDER BY rank 
          LIMIT 50
        `;
        
        const { results } = await env.DB.prepare(sql).bind(biennium, ftsQuery).all();
        return new Response(JSON.stringify(results), { headers: corsHeaders });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
      }
    }

    // --- 2. AUTO-FEEDER: BUILD ENTIRE DATABASE ---
    if (request.method === "POST" && url.pathname === "/build-database") {
      try {
        const { year, biennium } = await request.json();
        if (!year || !biennium) return new Response(JSON.stringify({ error: "Missing year or biennium" }), { status: 400, headers: corsHeaders });

        const reqBody = `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><GetLegislationByYear xmlns="http://WSLWebServices.leg.wa.gov/"><year>${year}</year></GetLegislationByYear></soap:Body></soap:Envelope>`;

        const res = await fetch("https://wslwebservices.leg.wa.gov/LegislationService.asmx", {
          method: "POST",
          headers: { "Content-Type": "text/xml; charset=utf-8", "SOAPAction": "http://WSLWebServices.leg.wa.gov/GetLegislationByYear" },
          body: reqBody
        });
        
        const xml = await res.text();
        const matches = [...xml.matchAll(/<BillNumber>(\d+)<\/BillNumber>/g)];
        const uniqueBills = [...new Set(matches.map(m => m[1]))];

        const stmt = env.DB.prepare("INSERT INTO scrape_queue (bill_number, biennium, status, last_attempt) VALUES (?, ?, 'pending', CURRENT_TIMESTAMP) ON CONFLICT(bill_number) DO NOTHING");
        const batch = [];
        for (const bill of uniqueBills) {
            batch.push(stmt.bind(bill, biennium));
        }
        
        for (let i = 0; i < batch.length; i += 100) {
            await env.DB.batch(batch.slice(i, i + 100));
        }

        return new Response(JSON.stringify({ success: true, total_bills_queued: uniqueBills.length }), { headers: corsHeaders });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
      }
    }

    // --- 3. EXISTING WEBHOOK: ADD SINGLE BILL TO QUEUE ---
    if (request.method === "POST" && url.pathname === "/add-to-queue") {
      try {
        const data = await request.json();
        await env.DB.prepare(`
          INSERT INTO scrape_queue (bill_number, biennium, status, last_attempt) 
          VALUES (?, ?, 'pending', CURRENT_TIMESTAMP)
          ON CONFLICT(bill_number) DO UPDATE SET status = 'pending', last_attempt = CURRENT_TIMESTAMP
        `).bind(data.bill_number, data.biennium).run();
        
        return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
      }
    }

    return new Response("LegiTile Scraper is online.", { status: 200, headers: corsHeaders });
  },

  async scheduled(event, env, ctx) {
    try {
      // Grab up to 3 pending bills from the queue
      const { results: queueItems } = await env.DB.prepare(
        "SELECT * FROM scrape_queue WHERE status = 'pending' LIMIT 3"
      ).all();

      if (queueItems && queueItems.length > 0) {
        for (const item of queueItems) {
          try {
            // Reverted back to the reliable GetLegislation API
            const apiBody = `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><GetLegislation xmlns="http://WSLWebServices.leg.wa.gov/"><biennium>${item.biennium}</biennium><billNumber>${item.bill_number}</billNumber></GetLegislation></soap:Body></soap:Envelope>`;
            
            const apiRes = await fetch("https://wslwebservices.leg.wa.gov/LegislationService.asmx", {
              method: "POST",
              headers: { "Content-Type": "text/xml; charset=utf-8", "SOAPAction": "http://WSLWebServices.leg.wa.gov/GetLegislation" },
              body: apiBody
            });
            
            const xml = await apiRes.text();
            
            // Forgiving Regex to find the HtmUrl
            const htmMatches = [...xml.matchAll(/<HtmUrl[^>]*>([^<]+)<\//gi)];
            
            if (htmMatches.length === 0) {
                 await env.DB.prepare("UPDATE scrape_queue SET status = 'failed_no_html', last_attempt = CURRENT_TIMESTAMP WHERE bill_number = ?").bind(item.bill_number).run();
                 continue;
            }

            // Grab the LAST url in the array (ensures we get the substitute/latest version)
            const documentUrl = htmMatches[htmMatches.length - 1][1].replace('http://', 'https://');

            // Download the actual bill text
            const docRes = await fetch(documentUrl);
            if (!docRes.ok) throw new Error(`HTTP ${docRes.status}`);
            const htmlText = await docRes.text();
            
            // Strip out the HTML structure to leave just raw, searchable text
            const cleanText = htmlText
                .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
                .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
                .replace(/<[^>]+>/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();

            // Overwrite the old text in the search database with the fresh text
            await env.DB.prepare("DELETE FROM bill_texts WHERE bill_number = ? AND biennium = ?").bind(item.bill_number, item.biennium).run();
            await env.DB.prepare("INSERT INTO bill_texts (bill_number, biennium, full_text) VALUES (?, ?, ?)").bind(item.bill_number, item.biennium, cleanText).run();
            
            // Mark as finished in the queue
            await env.DB.prepare("UPDATE scrape_queue SET status = 'scraped', last_attempt = CURRENT_TIMESTAMP WHERE bill_number = ?").bind(item.bill_number).run();

          } catch (scrapeError) {
            console.error(`Failed to scrape ${item.bill_number}:`, scrapeError);
            await env.DB.prepare("UPDATE scrape_queue SET status = 'failed', last_attempt = CURRENT_TIMESTAMP WHERE bill_number = ?").bind(item.bill_number).run();
          }
        }
      }
    } catch (queueError) {
      console.error("Scraper queue execution failed:", queueError);
    }
  }
};
