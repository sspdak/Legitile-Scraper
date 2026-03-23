export default {
  // A simple fetch handler just so the worker has a web endpoint if you need to manually ping it later
  async fetch(request, env) {
    return new Response("LegiTile Scraper Engine is online.", { status: 200 });
  },

  // The automated cron job that does the heavy lifting
  async scheduled(event, env, ctx) {
    try {
      // 1. Grab up to 3 pending bills from the queue table
      const { results: queueItems } = await env.DB.prepare(
        "SELECT * FROM scrape_queue WHERE status = 'pending' LIMIT 3"
      ).all();

      if (queueItems && queueItems.length > 0) {
        for (const item of queueItems) {
          try {
            // 2. Fetch the HTML document from the state legislature site
            const response = await fetch(item.document_url);
            
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            
            const htmlText = await response.text();
            
            // 3. Strip HTML tags to extract readable text
            const cleanText = htmlText
                .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
                .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
                .replace(/<[^>]+>/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();

            // 4. Insert or Update the searchable FTS5 table
            await env.DB.prepare("DELETE FROM bill_texts WHERE bill_number = ? AND biennium = ?").bind(item.bill_number, item.biennium).run();
            await env.DB.prepare(
              "INSERT INTO bill_texts (bill_number, biennium, full_text) VALUES (?, ?, ?)"
            ).bind(item.bill_number, item.biennium, cleanText).run();

            // 5. Mark the item as successfully scraped in the queue
            await env.DB.prepare(
              "UPDATE scrape_queue SET status = 'scraped', last_attempt = CURRENT_TIMESTAMP WHERE bill_number = ?"
            ).bind(item.bill_number).run();

          } catch (scrapeError) {
            console.error(`Failed to scrape ${item.bill_number}:`, scrapeError);
            // Mark as failed so it doesn't jam the queue forever
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
