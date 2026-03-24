export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    // Handle CORS
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

    // --- 1.5 REPORT ENDPOINT (Returns full text for section extraction) ---
    if (request.method === "GET" && url.pathname === "/generate-report") {
      const query = url.searchParams.get("q");
      const biennium = url.searchParams.get("biennium") || "2025-26";

      if (!query) return new Response(JSON.stringify({ error: "Missing query" }), { status: 400, headers: corsHeaders });

      try {
        const ftsQuery = `"${query.replace(/"/g, '""')}"`; 
        
        const sql = `
          SELECT bill_number, full_text 
          FROM bill_texts 
          WHERE biennium = ? AND bill_texts MATCH ? 
          ORDER BY rank 
          LIMIT 100
        `;
        
        const { results } = await env.DB.prepare(sql).bind(biennium, ftsQuery).all();
        return new Response(JSON.stringify(results), { headers: corsHeaders });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
      }
    }

    // --- 2. THE MASTER AUTO-FEEDER ---
    if (request.method === "POST" && url.pathname === "/build-database") {
      try {
        const { biennium } = await request.json();
        if (!biennium) return new Response(JSON.stringify({ error: "Missing biennium" }), { status: 400, headers: corsHeaders });

        // Fetch the master list of EVERY bill document for the biennium
        const reqBody = `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><GetAllDocumentsByClass xmlns="http://WSLWebServices.leg.wa.gov/"><biennium>${biennium}</biennium><documentClass>Bills</documentClass></GetAllDocumentsByClass></soap:Body></soap:Envelope>`;

        const res = await fetch("https://wslwebservices.leg.wa.gov/legislativedocumentservice.asmx", {
          method: "POST",
          headers: { "Content-Type": "text/xml; charset=utf-8", "SOAPAction": "http://WSLWebServices.leg.wa.gov/GetAllDocumentsByClass" },
          body: reqBody
        });
        
        const xml = await res.text();
        
        // Extract all HTML URLs from the massive payload
        const urlMatches = [...xml.matchAll(/<HtmUrl[^>]*>([^<]+)<\//gi)].map(m => m[1]);
        const billMap = new Map();

        for (const rawUrl of urlMatches) {
            const htmUrl = rawUrl.replace('http://', 'https://');
            const fileMatch = htmUrl.match(/\/([^/]+\.htm)$/i);
            
            if (fileMatch) {
                const fileName = fileMatch[1];
                const numMatch = fileName.match(/^(\d{4})/); // Gets the 4 digit bill number
                
                if (numMatch) {
                    const billNum = numMatch[1];
                    // Save the longest filename for each bill (Substitute/Engrossed suffixes make it longer)
                    if (!billMap.has(billNum) || fileName.length > billMap.get(billNum).fileName.length) {
                        billMap.set(billNum, { url: htmUrl, fileName: fileName });
                    }
                }
            }
        }

        // Insert exactly one URL per bill into the database queue
        const batch = [];
        const stmt = env.DB.prepare(`
            INSERT INTO scrape_queue (bill_number, biennium, document_url, status, last_attempt) 
            VALUES (?, ?, ?, 'pending', CURRENT_TIMESTAMP) 
            ON CONFLICT(bill_number) DO UPDATE SET 
                status = CASE WHEN scrape_queue.document_url != excluded.document_url THEN 'pending' ELSE scrape_queue.status END,
                document_url = excluded.document_url,
                last_attempt = CURRENT_TIMESTAMP
        `);

        for (const [billNum, data] of billMap.entries()) {
            batch.push(stmt.bind(billNum, biennium, data.url));
        }
        
        for (let i = 0; i < batch.length; i += 100) {
            await env.DB.batch(batch.slice(i, i + 100));
        }

        return new Response(JSON.stringify({ success: true, total_unique_bills_queued: billMap.size }), { headers: corsHeaders });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
      }
    }

    // --- 3. WEBHOOK FALLBACK (If you add a bill manually) ---
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
      // 1. Grab up to 3 pending bills from the queue
      const { results: queueItems } = await env.DB.prepare(
        "SELECT * FROM scrape_queue WHERE status = 'pending' LIMIT 3"
      ).all();

      if (queueItems && queueItems.length > 0) {
        for (const item of queueItems) {
          try {
            // Priority 1: Use the exact URL we found in the master list
            let targetUrl = item.document_url;
            
            // Priority 2: If no URL (added via webhook before bulk sync), guess the original URL
            if (!targetUrl) {
                const justNum = parseInt(item.bill_number.replace(/\D/g, ''));
                const chamberFolder = justNum < 5000 ? "House%20Bills" : "Senate%20Bills";
                targetUrl = `https://lawfilesext.leg.wa.gov/biennium/${item.biennium}/Htm/Bills/${chamberFolder}/${justNum}.htm`;
            }

            // 2. Download the text directly
            const docRes = await fetch(targetUrl);
            if (!docRes.ok) throw new Error(`HTTP ${docRes.status}`);
            const htmlText = await docRes.text();
            
            // 3. Strip HTML
            const cleanText = htmlText
                .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
                .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
                .replace(/<[^>]+>/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();

            // 4. Save to database
            await env.DB.prepare("DELETE FROM bill_texts WHERE bill_number = ? AND biennium = ?").bind(item.bill_number, item.biennium).run();
            await env.DB.prepare("INSERT INTO bill_texts (bill_number, biennium, full_text) VALUES (?, ?, ?)").bind(item.bill_number, item.biennium, cleanText).run();
            
            // 5. Mark finished
            await env.DB.prepare("UPDATE scrape_queue SET status = 'scraped', last_attempt = CURRENT_TIMESTAMP WHERE bill_number = ?").bind(item.bill_number).run();

          } catch (scrapeError) {
            console.error(`Failed to scrape ${item.bill_number}:`, scrapeError);
            await env.DB.prepare("UPDATE scrape_queue SET status = 'failed_no_html', last_attempt = CURRENT_TIMESTAMP WHERE bill_number = ?").bind(item.bill_number).run();
          }
        }
      }
    } catch (queueError) {
      console.error("Scraper queue execution failed:", queueError);
    }
  }
};
