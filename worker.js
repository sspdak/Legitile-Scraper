export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    // --- THE NEW WEBHOOK ---
    // This listens for incoming requests from your main dashboard
    if (request.method === "POST" && url.pathname === "/add-to-queue") {
      try {
        const data = await request.json();
        
        // Insert into the queue. If it's already there, reset to 'pending' to force a re-scrape.
        await env.DB.prepare(`
          INSERT INTO scrape_queue (bill_number, biennium, status, last_attempt) 
          VALUES (?, ?, 'pending', CURRENT_TIMESTAMP)
          ON CONFLICT(bill_number) DO UPDATE SET status = 'pending', last_attempt = CURRENT_TIMESTAMP
        `).bind(data.bill_number, data.biennium).run();
        
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
      }
    }

    return new Response("LegiTile Scraper is online.", { status: 200 });
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
            // Determine if House or Senate based on number (House < 5000)
            const justNum = parseInt(item.bill_number.replace(/\D/g, ''));
            const chamberFolder = justNum < 5000 ? "House%20Bills" : "Senate%20Bills";
            
            // Construct the Washington State HTML document URL
            const documentUrl = `https://lawfilesext.leg.wa.gov/biennium/${item.biennium}/Htm/Bills/${chamberFolder}/${justNum}.htm`;

            const response = await fetch(documentUrl);
            if (!response.ok) throw new Error(`HTTP ${response.status} at ${documentUrl}`);
            
            const htmlText = await response.text();
            
            // 3. Strip HTML tags to extract raw text
            const cleanText = htmlText
                .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
                .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
                .replace(/<[^>]+>/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();

            // 4. Save to the FTS5 searchable database
            await env.DB.prepare("DELETE FROM bill_texts WHERE bill_number = ? AND biennium = ?").bind(item.bill_number, item.biennium).run();
            await env.DB.prepare(
              "INSERT INTO bill_texts (bill_number, biennium, full_text) VALUES (?, ?, ?)"
            ).bind(item.bill_number, item.biennium, cleanText).run();

            // 5. Mark as successfully scraped
            await env.DB.prepare(
              "UPDATE scrape_queue SET status = 'scraped', last_attempt = CURRENT_TIMESTAMP WHERE bill_number = ?"
            ).bind(item.bill_number).run();

          } catch (scrapeError) {
            console.error(`Failed to scrape ${item.bill_number}:`, scrapeError);
            await env.DB.prepare(
              "UPDATE scrape_queue SET status = 'failed', last_attempt = CURRENT_TIMESTAMP WHERE bill_number = ?"
            ).bind(item.bill_number).run();
          }
        }
      }
    } catch (queueError) {
      console.error("Scraper queue execution failed:", queueError);
    }
  }
};
