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

    // --- 1.1 GET TRACKED SESSIONS ---
    if (request.method === "GET" && url.pathname === "/get-bienniums") {
      try {
        const { results } = await env.DB.prepare("SELECT DISTINCT biennium FROM scrape_queue ORDER BY biennium DESC").all();
        let bienniums = results.map(r => r.biennium);
        if (bienniums.length === 0) bienniums = ["2025-26"]; 
        return new Response(JSON.stringify(bienniums), { headers: corsHeaders });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
      }
    }

    // --- 1.2 HISTORICAL AUTO-FEEDER ---
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

        const allFiles = new Set();
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
              const fullUrl = fileHref.startsWith('http') ? fileHref : (fileHref.startsWith('/') ? `https://lawfilesext.leg.wa.gov${fileHref}` : `${dirUrl}${fileHref}`);
              allFiles.add(JSON.stringify({ billNumber: billNumMatch[1], url: fullUrl, biennium: biennium }));
            }
          }
        }

        const insertStmt = env.DB.prepare(
          "INSERT OR IGNORE INTO scrape_queue (bill_number, url, biennium, status) VALUES (?, ?, ?, 'pending')"
        );
        
        const batch = [];
        for (const fileStr of allFiles) {
          const bill = JSON.parse(fileStr);
          batch.push(insertStmt.bind(bill.billNumber, bill.url, bill.biennium));
          if (batch.length === 50) { 
            await env.DB.batch(batch); 
            batch.length = 0; 
          }
        }
        if (batch.length > 0) await env.DB.batch(batch);

        return new Response(JSON.stringify({ success: true, total_files_queued: allFiles.size }), { headers: corsHeaders });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
      }
    }

    // --- 1.3 URL DIRECTORY (For identifying ghost phrases) ---
    if (request.method === "GET" && url.pathname === "/all-urls") {
      const biennium = url.searchParams.get("biennium") || "2025-26";
      try {
        const { results } = await env.DB.prepare("SELECT bill_number, url FROM scrape_queue WHERE biennium = ? AND status = 'completed'").bind(biennium).all();
        const map = {};
        results.forEach(r => {
            if(!map[r.bill_number]) map[r.bill_number] = [];
            map[r.bill_number].push(r.url);
        });
        return new Response(JSON.stringify(map), { headers: corsHeaders });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
      }
    }

    // --- 1.4 REPORT ENDPOINT ---
    if (request.method === "GET" && url.pathname === "/generate-report") {
      const query = url.searchParams.get("q");
      const biennium = url.searchParams.get("biennium") || "2025-26";

      if (!query) return new Response(JSON.stringify({ error: "Missing query" }), { status: 400, headers: corsHeaders });

      try {
        const ftsQuery = `"${query.replace(/"/g, '""')}"`; 
        const sql = `
          SELECT bill_number, url, full_text 
          FROM bill_texts 
          WHERE biennium = ? AND bill_texts MATCH ? 
          ORDER BY rank 
          LIMIT 5000
        `;
        const { results } = await env.DB.prepare(sql).bind(biennium, ftsQuery).all();
        return new Response(JSON.stringify(results), { headers: corsHeaders });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
      }
    }

// --- 1.5 PROXY ENDPOINT FOR BILL STATUS ---
    if (request.method === "GET" && url.pathname === "/get-bill-status") {
      const billNumber = url.searchParams.get("billNumber");
      const biennium = url.searchParams.get("biennium") || "2025-26";

      if (!billNumber) return new Response(JSON.stringify({ error: "Missing bill number" }), { status: 400, headers: corsHeaders });

      try {
        // Fetch from all 3 WSL endpoints to get comprehensive data
        const fetchWSL = async (op, body) => {
          const res = await fetch(`https://wslwebservices.leg.wa.gov/LegislationService.asmx`, {
            method: "POST",
            headers: { "Content-Type": "text/xml; charset=utf-8", "SOAPAction": `http://WSLWebServices.leg.wa.gov/${op}` },
            body: `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>${body}</soap:Body></soap:Envelope>`
          });
          return (await res.text()).replace(/<\?xml.*?\?>/i, "");
        };

        const calls = [
          { op: "GetLegislation", body: `<GetLegislation xmlns="http://WSLWebServices.leg.wa.gov/"><biennium>${biennium}</biennium><billNumber>${billNumber.replace(/\D/g, '')}</billNumber></GetLegislation>` },
          { op: "GetSponsors", body: `<GetSponsors xmlns="http://WSLWebServices.leg.wa.gov/"><biennium>${biennium}</biennium><billId>${billNumber.replace(/\D/g, '')}</billId></GetSponsors>` },
          { op: "GetCurrentStatus", body: `<GetCurrentStatus xmlns="http://WSLWebServices.leg.wa.gov/"><biennium>${biennium}</biennium><billNumber>${billNumber.replace(/\D/g, '')}</billNumber></GetCurrentStatus>` }
        ];
        
        const results = await Promise.all(calls.map(c => fetchWSL(c.op, c.body)));
        const xml = `<Root>${results.join('')}</Root>`;
        
        const statusMatch = xml.match(/<[^>]*?HistoryLine[^>]*?>\s*([^<]+)\s*<\//i);
        const titleMatch = xml.match(/<[^>]*?ShortDescription[^>]*?>\s*([^<]+)\s*<\//i);

        const isoDates = [...xml.matchAll(/>\s*(\d{4}-\d{2}-\d{2})T/g)].map(m => m[1]).filter(date => !date.startsWith('1901') && !date.startsWith('1900') && !date.startsWith('0001'));
        
        let introDate = "Unknown", lastUpdated = "Unknown";
        if (isoDates.length > 0) {
          isoDates.sort();
          const formatIso = (isoStr) => {
            const parts = isoStr.split('-');
            return new Date(parts[0], parts[1] - 1, parts[2]).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
          };
          introDate = formatIso(isoDates[0]);
          lastUpdated = formatIso(isoDates[isoDates.length - 1]);
        }
        
        // Safely extract the primary sponsor
        let sponsor = "Unknown";
        const sponsorMatch = xml.match(/<Name>([^<]+)<\/Name>/i);
        if (sponsorMatch && sponsorMatch[1]) {
            sponsor = sponsorMatch[1].trim();
        }

        const status = statusMatch && statusMatch[1] ? statusMatch[1].trim() : "Status Unavailable";
        const title = titleMatch && titleMatch[1] ? titleMatch[1].trim() : "Title Unavailable";
        
        return new Response(JSON.stringify({ sponsor, status, short_desc: title, intro_date: introDate, last_updated: lastUpdated }), { headers: corsHeaders });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
      }
    }

    // --- 1.6 SAVED QUERIES ---
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

    // --- 1.7 DB STATS ENDPOINT ---
    if (request.method === "GET" && url.pathname === "/db-stats") {
      const biennium = url.searchParams.get("biennium") || "2025-26";
      try {
        const result = await env.DB.prepare("SELECT COUNT(DISTINCT bill_number) as total FROM scrape_queue WHERE biennium = ? AND status = 'completed'").bind(biennium).first();
        return new Response(JSON.stringify({ total_bills: result.total }), { headers: corsHeaders });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
      }
    }
    
    // --- FALLBACK ---
    return new Response("LegiTile Scraper is online.", { headers: corsHeaders });
  },

  // --- 2. BACKGROUND CRON JOB ---
  async scheduled(event, env, ctx) {
    const { results: queueItems } = await env.DB.prepare(
      "SELECT * FROM scrape_queue WHERE status = 'pending' LIMIT 10"
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
                            .replace(/[\u0000-\u0008\u000B-\u000C\u000E-\u001F\uFFFD]/g, '')
                            .trim();

        if (cleanText.length > 900000) {
            const topChunk = cleanText.substring(0, 500000);
            const bottomChunk = cleanText.substring(cleanText.length - 400000);
            cleanText = topChunk + " ...[TEXT TRUNCATED FOR SIZE]... " + bottomChunk;
        }

        await env.DB.batch([
          env.DB.prepare(
            "DELETE FROM bill_texts WHERE url = ?"
          ).bind(item.url),
          
          env.DB.prepare(
            "INSERT INTO bill_texts (bill_number, biennium, url, full_text) VALUES (?, ?, ?, ?)"
          ).bind(item.bill_number, item.biennium, item.url, cleanText),
          
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
