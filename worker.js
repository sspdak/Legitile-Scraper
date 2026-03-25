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

    // --- 1. MASTER AUTO-FEEDER ---
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
        const fetchErrors = []; 

        for (const dirUrl of directories) {
          const res = await fetch(dirUrl);
          if (!res.ok) {
            fetchErrors.push(`Blocked reading ${dirUrl}: HTTP ${res.status}`);
            continue; 
          }
          
          const html = await res.text();
          let match;

          while ((match = regex.exec(html)) !== null) {
            const fileName = match[1];
            const billNumMatch = fileName.match(/^(\d{4})/);

            if (billNumMatch) {
              const billNum = billNumMatch[1];
              if (!uniqueBills.has(billNum) || fileName.length > uniqueBills.get(billNum).fileName.length) {
                uniqueBills.set(billNum, {
                  billNumber: billNum,
                  url: `${dirUrl}${fileName}`,
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

        return new Response(JSON.stringify({ 
          success: true, 
          total_unique_bills_queued: uniqueBills.size,
          diagnostics: fetchErrors 
        }), { headers: corsHeaders });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
      }
    }

    return new Response("LegiTile Scraper is online, clean, and reset.", { headers: corsHeaders });
  }
};
