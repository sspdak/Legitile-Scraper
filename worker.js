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
        const sql = `
          SELECT bill_number, snippet(bill_texts, 1, '<mark class="bg-yellow-200 text-gray-900 font-bold px-1 rounded">', '</mark>', '...', 60) AS match_snippet 
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

    // --- 1.2 MASTER AUTO-FEEDER (X-RAY MODE) ---
    if (request.method === "POST" && url.pathname === "/build-database") {
      try {
        const testUrl = "https://lawfilesext.leg.wa.gov/biennium/2025-26/Htm/Bills/Senate%20Bills/";
        
        // Fetching the directory with a standard browser User-Agent to mimic a real user
        const res = await fetch(testUrl, {
          headers: { 
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" 
          }
        });
        
        const html = await res.text();
        
        // Return the RAW webpage text back to you in the dashboard
        return new Response(html, { headers: { "Content-Type": "text/plain", ...corsHeaders } });
      } catch (e) {
         return new Response(e.message, { status: 500, headers: corsHeaders });
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
        
        const sponsor = sponsorMatch && sponsorMatch[1] ? sponsorMatch[1].replace(/[()]/g, '').trim() : "Unknown";
        const status = statusMatches.length > 0 ? statusMatches[statusMatches.length - 1][1].trim() : "Status Unavailable";
        
        return new Response(JSON.stringify({ sponsor, status }), { headers: corsHeaders });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
      }
    }

    // --- 1.7 SAVED QUERIES (D1 Database Storage) ---
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

    return new Response("LegiTile Scraper is online.", { headers: corsHeaders });
  },

  // --- 2. THE BACKGROUND CRON JOB ---
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
            "INSERT OR REPLACE INTO bill_texts (bill_number, biennium, full_text) VALUES (?, ?, ?)"
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
