const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    // --- 1.1 SEARCH ENDPOINT ---
    if (request.method === "GET" && url.pathname === "/search") {
      const query = url.searchParams.get("q");
      const biennium = url.searchParams.get("biennium") || "2025-26";
      
      if (!query) return new Response(JSON.stringify({ error: "Missing query" }), { status: 400, headers: corsHeaders });
      
      try {
        const ftsQuery = `"${query.replace(/"/g, '""')}"`; 
        const { results } = await env.DB.prepare(`
          SELECT bill_number, snippet(bill_texts, 1, '<mark class="bg-yellow-200 text-gray-900 font-bold px-1 rounded">', '</mark>', '...', 60) AS match_snippet 
          FROM bill_texts 
          WHERE biennium = ? AND bill_texts MATCH ? 
          ORDER BY rank LIMIT 50
        `).bind(biennium, ftsQuery).all();
        
        return new Response(JSON.stringify(results), { headers: corsHeaders });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
      }
    }

    // --- 1.2 MASTER AUTO-FEEDER ---
    if (request.method === "POST" && url.pathname === "/build-database") {
      try {
        const { biennium } = await request.json();
        if (!biennium) throw new Error("Missing biennium");

        const directories = [
          `https://lawfilesext.leg.wa.gov/biennium/${biennium}/Htm/Bills/House%20Bills/`,
          `https://lawfilesext.leg.wa.gov/biennium/${biennium}/Htm/Bills/Senate%20Bills/`,
          `https://lawfilesext.leg.wa.gov/biennium/${biennium}/Htm/Bills/House%20Passed%20Legislature/`,
          `https://lawfilesext.leg.wa.gov/biennium/${biennium}/Htm/Bills/Senate%20Passed%20Legislature/`
        ];

        const uniqueBills = new Map();
        const regex = /href="([^"]+\.htm)"/gi;

        for (const dirUrl of directories) {
          const res = await fetch(dirUrl);
          if (!res.ok) continue;
          
          const html = await res.text();
          let match;

          while ((match = regex.exec(html)) !== null) {
            const fileHref = match[1];
            const fileName = fileHref.split('/').pop();
            const billNumMatch = fileName.match(/^(\d{4})/);

            if (billNumMatch) {
              const billNum = billNumMatch[1];
              if (!uniqueBills.has(billNum) || fileName.length > uniqueBills.get(billNum).fileName.length) {
                uniqueBills.set(billNum, {
                  billNumber: billNum,
                  url: fileHref.startsWith('http') ? fileHref : (fileHref.startsWith('/') ? `https://lawfilesext.leg.wa.gov${fileHref}` : `${dirUrl}${fileHref}`),
                  fileName: fileName,
                  biennium: biennium
                });
              }
            }
          }
        }

        const insertStmt = env.DB.prepare(
          "INSERT OR REPLACE INTO scrape_queue (bill_number, url, biennium, status) VALUES (?, ?, ?, 'pending')"
        );
        
        const batch = [];
        for (const bill of uniqueBills.values()) {
          batch.push(insertStmt.bind(bill.billNumber, bill.url, bill.biennium));
          if (batch.length === 50) { 
            await env.DB.batch(batch); 
            batch.length = 0; 
          }
        }
        if (batch.length > 0) await env.DB.batch(batch);

        return new Response(JSON.stringify({ success: true, total_unique_bills_queued: uniqueBills.size }), { headers: corsHeaders });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
      }
    }

    // --- 1.5 REPORT ENDPOINT ---
    if (request.method === "GET" && url.pathname === "/generate-report") {
      const query = url.searchParams.get("q");
      const biennium = url.searchParams.get("biennium") || "2025-26";

      if (!query) return new Response(JSON.stringify({ error: "Missing query" }), { status: 400, headers: corsHeaders });

      try {
        const ftsQuery = `"${query.replace(/"/g, '""')}"`; 
        const sql = `
          SELECT t.bill_number, t.full_text, q.url 
          FROM bill_texts t 
          LEFT JOIN scrape_queue q ON t.bill_number = q.bill_number AND t.biennium = q.biennium 
          WHERE t.biennium = ? AND t.bill_texts MATCH ? 
          ORDER BY t.rank 
          LIMIT 100
        `;
        const { results } = await env.DB.prepare(sql).bind(biennium, ftsQuery).all();
        return new Response(JSON.stringify(results), { headers: corsHeaders });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
      }
    }

    // --- 1.6 PROXY ENDPOINT FOR BILL STATUS ---
    if (request.method === "GET" && url.pathname === "/get-bill-status") {
      const billNumber = url.searchParams.get("billNumber");
      const biennium = url.searchParams.get("biennium") || "2025-26";

      if (!billNumber) return new Response(JSON.stringify({ error: "Missing bill number" }), { status: 400, headers: corsHeaders });

      try {
        const reqBody = `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><GetLegislation xmlns="http://WSLWebServices.leg.wa.gov/"><biennium>${biennium}</biennium><billNumber>${billNumber.replace(/\D/g, '')}</billNumber></GetLegislation></soap:Body></soap:Envelope>`;
        
        const apiRes = await fetch("https://wslwebservices.leg.wa.gov/LegislationService.asmx", {
          method: "POST",
          headers: { "Content-Type": "text/xml; charset=utf-8", "SOAPAction": "http://WSLWebServices.leg.wa.gov/GetLegislation" },
          body: reqBody
        });
        
        const xml = await apiRes.text();
        
        const sponsorMatch = xml.match(/<[^>]*?OriginalSponsor[^>]*?>\s*([^<]+)\s*<\//i) || 
                             xml.match(/<[^>]*?SponsorName[^>]*?>\s*([^<]+)\s*<\//i) ||
                             xml.match(/<[^>]*?Sponsor[^>]*?>\s*([^<]+)\s*<\//i) ||
                             xml.match(/<[^>]*?LongFriendlyName[^>]*?>\s*([^<]+)\s*<\//i);
                             
        const statusMatches = [...xml.matchAll(/<[^>]*?HistoryLine[^>]*?>\s*([^<]+)\s*<\//gi)];
        const titleMatch = xml.match(/<[^>]*?ShortDescription[^>]*?>\s*([^<]+)\s*<\//i) || 
                           xml.match(/<[^>]*?LongDescription[^>]*?>\s*([^<]+)\s*<\//i);

        // Date extraction
        const isoDates = [...xml.matchAll(/>\s*(\d{4}-\d{2}-\d{2})T/g)].map(m => m[1]);
        let introDate = "Unknown";
        let lastUpdated = "Unknown";
        
        if (isoDates.length > 0) {
          isoDates.sort();
          const formatIso = (isoStr) => {
            const parts = isoStr.split('-');
            return new Date(parts[0], parts[1] - 1, parts[2]).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
          };
          introDate = formatIso(isoDates[0]);
          lastUpdated = formatIso(isoDates[isoDates.length - 1]);
        }
        
        const sponsor = sponsorMatch && sponsorMatch[1] ? sponsorMatch[1].replace(/[()]/g, '').trim() : "Unknown";
        const status = statusMatches.length > 0 ? statusMatches[statusMatches.length - 1][1].trim() : "Status Unavailable";
        const title = titleMatch && titleMatch[1] ? titleMatch[1].trim() : "Title Unavailable";
        
        return new Response(JSON.stringify({ sponsor, status, short_desc: title, intro_date: introDate, last_updated: lastUpdated }), { headers: corsHeaders });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
      }
    }

    // --- 1.7 SAVED QUERIES ---
    if (url.pathname === "/saved-queries") {
      if (request.method === "GET") {
        try {
          const { results } = await env.DB.prepare("SELECT query_text FROM saved_queries ORDER BY id DESC").all();
          return new Response(JSON.stringify(results.map(r => r.query_text)), { headers: corsHeaders });
        } catch (e) {
          return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
        }
      }
      
      if (request.method === "POST") {
        try {
          const { action, query } = await request.json();
          if (action === "save" && query) {
            await env.DB.prepare("INSERT OR IGNORE INTO saved_queries (query_text) VALUES (?)").bind(query).run();
          } else if (action === "clear") {
            await env.DB.prepare("DELETE FROM saved_queries").run();
          }
          return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
        } catch (e) {
          return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
        }
      }
    }

    // --- 1.8 DB STATS ENDPOINT ---
    if (request.method === "GET" && url.pathname === "/db-stats") {
      const biennium = url.searchParams.get("biennium") || "2025-26";
      try {
        const result = await env.DB.prepare("SELECT COUNT(DISTINCT bill_number) as total FROM bill_texts WHERE biennium = ?").bind(biennium).first();
        return new Response(JSON.stringify({ total_bills: result.total }), { headers: corsHeaders });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
      }
    }
    
    return new Response("LegiTile Scraper is online.", { headers: corsHeaders });
  },

  // --- 2. BACKGROUND CRON JOB ---
  async scheduled(event, env, ctx) {
    const { results: queueItems } = await env.DB.prepare(
      "SELECT * FROM scrape_queue WHERE status = 'pending' LIMIT 2"
    ).all();

    if (!queueItems || queueItems.length === 0) return;

    for (const item of queueItems) {
      try {
        const response = await fetch(item.url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        
        const html = await response.text();
        let cleanText = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
                            .replace(/<[^>]+>/g, ' ')
                            .replace(/\s+/g, ' ')
                            .trim();

        await env.DB.batch([
          env.DB.prepare(
            "DELETE FROM bill_texts WHERE bill_number = ? AND biennium = ?"
          ).bind(item.bill_number, item.biennium),
          
          env.DB.prepare(
            "INSERT INTO bill_texts (bill_number, biennium, full_text) VALUES (?, ?, ?)"
          ).bind(item.bill_number, item.biennium, cleanText),
          
          env.DB.prepare(
            "UPDATE scrape_queue SET status = 'completed', last_scraped = CURRENT_TIMESTAMP WHERE id = ?"
          ).bind(item.id)
        ]);

      } catch (error) {
        await env.DB.prepare(
          "UPDATE scrape_queue SET status = 'failed' WHERE id = ?"
        ).bind(item.id).run();
      }
    }
  }
};
