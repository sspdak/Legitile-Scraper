export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

    const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

    async function signJWT(payload, secret) {
      const encoder = new TextEncoder();
      const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" })).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
      const encodedPayload = btoa(JSON.stringify(payload)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
      const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(`${header}.${encodedPayload}`));
      const encodedSignature = btoa(String.fromCharCode(...new Uint8Array(signature))).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
      return `${header}.${encodedPayload}.${encodedSignature}`;
    }

    async function verifyJWT(request, secret) {
      const authHeader = request.headers.get("Authorization");
      if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
      const token = authHeader.split(" ")[1];
      try {
        const parts = token.split('.');
        if (parts.length !== 3) return null;
        const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
        const validSignature = await signJWT(payload, secret);
        return token === validSignature ? payload.email : null;
      } catch (e) { return null; }
    }

    if (path === "/register" && request.method === "POST") {
      try {
        const { email, password, name, chamber, committees } = await request.json();
        const committeesJson = JSON.stringify(committees || []);

        const encoder = new TextEncoder();
        const passwordKey = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
        const hashBuffer = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: encoder.encode(email), iterations: 100000, hash: "SHA-256" }, passwordKey, 256);
        const passwordHash = btoa(String.fromCharCode(...new Uint8Array(hashBuffer)));
        
        await env.DB.prepare("INSERT INTO users (email, password_hash, name, chamber, committees) VALUES (?, ?, ?, ?, ?)")
          .bind(email, passwordHash, name || null, chamber || null, committeesJson)
          .run();
          
        return new Response(JSON.stringify({ success: true }), { headers });
      } catch (e) { return new Response("Error: Email might exist.", { status: 400, headers }); }
    }

    if (path === "/login" && request.method === "POST") {
      try {
        const { email, password } = await request.json();
        const encoder = new TextEncoder();
        const passwordKey = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
        const hashBuffer = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: encoder.encode(email), iterations: 100000, hash: "SHA-256" }, passwordKey, 256);
        const passwordHash = btoa(String.fromCharCode(...new Uint8Array(hashBuffer)));
        const result = await env.DB.prepare("SELECT * FROM users WHERE email = ? AND password_hash = ?").bind(email, passwordHash).first();
        if (result) {
          const token = await signJWT({ email: email, exp: Date.now() + 86400000 }, env.JWT_SECRET || "fallback_secret");
          return new Response(JSON.stringify({ success: true, token: token, email: email }), { headers });
        } else { return new Response("Invalid credentials.", { status: 401, headers }); }
      } catch (e) { return new Response("Login error.", { status: 500, headers }); }
    }

    const userEmail = await verifyJWT(request, env.JWT_SECRET || "fallback_secret");
    if (!userEmail && request.method !== "OPTIONS") return new Response("Unauthorized", { status: 401, headers });

    if (path === "/me" && request.method === "GET") {
      try {
        const user = await env.DB.prepare("SELECT email, name, chamber, committees FROM users WHERE email = ?").bind(userEmail).first();
        if (!user) return new Response("User not found", { status: 404, headers });
        user.committees = JSON.parse(user.committees || "[]");
        return new Response(JSON.stringify(user), { headers });
      } catch (e) { return new Response("Database error", { status: 500, headers }); }
    }

    if (path === "/update-profile" && request.method === "POST") {
      try {
        const { name, chamber, committees } = await request.json();
        const committeesJson = JSON.stringify(committees || []);
        
        await env.DB.prepare("UPDATE users SET name = ?, chamber = ?, committees = ? WHERE email = ?")
          .bind(name, chamber, committeesJson, userEmail)
          .run();
          
        return new Response(JSON.stringify({ success: true }), { headers });
      } catch (e) { return new Response("Database error", { status: 500, headers }); }
    }

    if (path === "/preferences" && request.method === "GET") {
      try {
        await env.DB.prepare("CREATE TABLE IF NOT EXISTS user_preferences (user_email TEXT PRIMARY KEY, cd_mode TEXT, cd_date TEXT, meeting_filter TEXT)").run();
        try { await env.DB.prepare("ALTER TABLE user_preferences ADD COLUMN meeting_filter TEXT").run(); } catch(e) {}
        
        const prefs = await env.DB.prepare("SELECT cd_mode, cd_date, meeting_filter FROM user_preferences WHERE user_email = ?").bind(userEmail).first();
        return new Response(JSON.stringify(prefs || { cd_mode: 'sinedie', cd_date: '2026-03-12', meeting_filter: 'all' }), { headers });
      } catch (e) { return new Response("Database error", { status: 500, headers }); }
    }

    if (path === "/preferences" && request.method === "POST") {
      try {
        await env.DB.prepare("CREATE TABLE IF NOT EXISTS user_preferences (user_email TEXT PRIMARY KEY, cd_mode TEXT, cd_date TEXT, meeting_filter TEXT)").run();
        try { await env.DB.prepare("ALTER TABLE user_preferences ADD COLUMN meeting_filter TEXT").run(); } catch(e) {}
        
        const data = await request.json();
        await env.DB.prepare(`
          INSERT INTO user_preferences (user_email, cd_mode, cd_date, meeting_filter) 
          VALUES (?, ?, ?, ?) 
          ON CONFLICT(user_email) DO UPDATE SET cd_mode = excluded.cd_mode, cd_date = excluded.cd_date, meeting_filter = excluded.meeting_filter
        `).bind(userEmail, data.cd_mode, data.cd_date, data.meeting_filter || 'all').run();
        return new Response(JSON.stringify({ success: true }), { headers });
      } catch (e) { return new Response("Database error", { status: 500, headers }); }
    }

    if (path === "/bienniums" && request.method === "GET") {
      try {
        let { results } = await env.DB.prepare("SELECT * FROM bienniums WHERE user_email = ? ORDER BY name DESC").bind(userEmail).all();
        if (results.length === 0) {
          await env.DB.prepare("INSERT INTO bienniums (user_email, name, is_active) VALUES (?, ?, 1)").bind(userEmail, '2025-26').run();
          results = [{ id: 1, user_email: userEmail, name: '2025-26', is_active: 1 }];
        }
        return new Response(JSON.stringify(results), { headers });
      } catch (e) { return new Response("Database error", { status: 500, headers }); }
    }

    if (path === "/bienniums" && request.method === "POST") {
      try {
        const { name } = await request.json();
        await env.DB.prepare("INSERT INTO bienniums (user_email, name, is_active) VALUES (?, ?, 1)").bind(userEmail, name).run();
        return new Response(JSON.stringify({ success: true }), { headers });
      } catch (e) { return new Response(JSON.stringify({ error: "Biennium may already exist." }), { status: 400, headers }); }
    }

    if (path === "/archive-biennium" && request.method === "POST") {
      try {
        const { name, is_active } = await request.json();
        await env.DB.prepare("UPDATE bienniums SET is_active = ? WHERE name = ? AND user_email = ?").bind(is_active, name, userEmail).run();
        return new Response(JSON.stringify({ success: true }), { headers });
      } catch (e) { return new Response("Database error", { status: 500, headers }); }
    }

    if (path === "/fetch-bill") {
      const bill = url.searchParams.get('bill');
      const biennium = url.searchParams.get('biennium') || '2025-26';
      if (!bill) return new Response("Missing bill", { status: 400, headers });
      
      const fetchWSL = async (op, body) => {
        const res = await fetch(`https://wslwebservices.leg.wa.gov/LegislationService.asmx`, {
          method: "POST",
          headers: { "Content-Type": "text/xml; charset=utf-8", "SOAPAction": `http://WSLWebServices.leg.wa.gov/${op}` },
          body: `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>${body}</soap:Body></soap:Envelope>`
        });
        return (await res.text()).replace(/<\?xml.*?\?>/i, "");
      };

      const calls = [
        { op: "GetLegislation", body: `<GetLegislation xmlns="http://WSLWebServices.leg.wa.gov/"><biennium>${biennium}</biennium><billNumber>${bill}</billNumber></GetLegislation>` },
        { op: "GetSponsors", body: `<GetSponsors xmlns="http://WSLWebServices.leg.wa.gov/"><biennium>${biennium}</biennium><billId>${bill}</billId></GetSponsors>` },
        { op: "GetCurrentStatus", body: `<GetCurrentStatus xmlns="http://WSLWebServices.leg.wa.gov/"><biennium>${biennium}</biennium><billNumber>${bill}</billNumber></GetCurrentStatus>` }
      ];
      const results = await Promise.all(calls.map(c => fetchWSL(c.op, c.body)));
      return new Response(`<?xml version="1.0" encoding="UTF-8"?><Root>${results.join('')}</Root>`, { headers: { "Content-Type": "application/xml", "Access-Control-Allow-Origin": "*" } });
    }

    if (path === "/save-bill" && request.method === "POST") {
      try {
        const data = await request.json();
        const targetBiennium = data.biennium || '2025-26';
        
        const existingBill = await env.DB.prepare("SELECT id, is_deleted FROM workspace WHERE user_email = ? AND bill_number = ? AND biennium = ?")
          .bind(userEmail, data.billNumber, targetBiennium)
          .first();

        if (existingBill) {
          if (existingBill.is_deleted === 1) {
            await env.DB.prepare(`
              UPDATE workspace 
              SET is_deleted = 0, short_desc = ?, status = ?, sponsor = ?, companion = ?, committee = ?, tracking_status = ?, type = ?
              WHERE id = ?
            `).bind(
              data.shortDesc, data.status, data.sponsor, data.companion, data.committee || 'Unknown', 
              data.tracking_status || 'Introduced', data.type || 'live', existingBill.id
            ).run();
            
            // WHISPER TO SCRAPER TO RE-INDEX RESTORED BILL
            ctx.waitUntil(
              fetch("https://legitile-scraper.ewing-jacob.workers.dev/add-to-queue", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ bill_number: data.billNumber, biennium: targetBiennium })
              }).catch(() => {}) 
            );

            return new Response(JSON.stringify({ success: true, message: "Restored and updated" }), { headers });
          } else {
            return new Response(JSON.stringify({ message: "Already tracking this bill in this biennium" }), { status: 409, headers });
          }
        }

        await env.DB.prepare(`
          INSERT INTO workspace (user_email, bill_number, short_desc, status, sponsor, companion, committee, tracking_status, type, biennium) 
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          userEmail, data.billNumber, data.shortDesc, data.status, data.sponsor, data.companion, 
          data.committee || 'Unknown', data.tracking_status || 'Introduced', data.type || 'live', targetBiennium
        ).run();

        // WHISPER TO SCRAPER TO INDEX BRAND NEW BILL
        ctx.waitUntil(
          fetch("https://legitile-scraper.ewing-jacob.workers.dev/add-to-queue", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ bill_number: data.billNumber, biennium: targetBiennium })
          }).catch(() => {}) 
        );

        return new Response(JSON.stringify({ success: true }), { headers });
      } catch (e) { return new Response("Database error", { status: 500, headers }); }
    }

    if (path === "/update-bill" && request.method === "POST") {
      try {
        const data = await request.json();
        
        await env.DB.prepare(`
          UPDATE workspace SET 
            status = ?, tracking_status = ?, type = ?, short_desc = ?, sponsor = ?, companion = ?, committee = ?, 
            live_notes = ?, task_progress = ?, custom_tasks = ?, hearing_date = ?, exec_date = ?, amendments = ? 
          WHERE id = ? AND user_email = ?
        `).bind(
          data.status, data.tracking_status, data.type, data.short_desc, data.sponsor, data.companion, data.committee, 
          data.live_notes, data.task_progress, data.custom_tasks, data.hearing_date, data.exec_date, data.amendments, 
          data.id, userEmail
        ).run();
        
        return new Response(JSON.stringify({ success: true }), { headers });
      } catch (e) { return new Response("Database error", { status: 500, headers }); }
    }

    if (path === "/delete-bill" && request.method === "DELETE") {
      try {
        const data = await request.json();
        await env.DB.prepare("UPDATE workspace SET is_deleted = 1 WHERE id = ? AND user_email = ?").bind(data.id, userEmail).run();
        return new Response(JSON.stringify({ success: true }), { headers });
      } catch (e) { return new Response("Database error", { status: 500, headers }); }
    }

    if (path === "/my-workspace" && request.method === "GET") {
      try {
        const biennium = url.searchParams.get('biennium') || '2025-26';
        const { results } = await env.DB.prepare("SELECT * FROM workspace WHERE user_email = ? AND is_deleted = 0 AND biennium = ? ORDER BY added_on DESC").bind(userEmail, biennium).all();
        
        const bienniumData = await env.DB.prepare("SELECT is_active FROM bienniums WHERE name = ? AND user_email = ?").bind(biennium, userEmail).first();
        const isActiveSession = bienniumData ? (bienniumData.is_active === 1) : false;

        if (isActiveSession) {
            const refreshBills = results.map(async (bill) => {
                if (bill.type === 'draft') return bill;
                try {
                    const res = await fetch(`https://wslwebservices.leg.wa.gov/LegislationService.asmx`, {
                        method: "POST",
                        headers: { "Content-Type": "text/xml; charset=utf-8", "SOAPAction": "http://WSLWebServices.leg.wa.gov/GetCurrentStatus" },
                        body: `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><GetCurrentStatus xmlns="http://WSLWebServices.leg.wa.gov/"><biennium>${biennium}</biennium><billNumber>${bill.bill_number}</billNumber></GetCurrentStatus></soap:Body></soap:Envelope>`
                    });
                    const xmlText = await res.text();
                    const statusMatch = xmlText.match(/<HistoryLine>(.*?)<\/HistoryLine>/i);
                    const freshStatus = statusMatch ? statusMatch[1].trim() : bill.status;

                    if (freshStatus !== bill.status) {
                        let tp = {};
                        try { tp = JSON.parse(bill.task_progress || "{}"); } catch(e) {}
                        tp._sys_alert = `Status changed to: ${freshStatus}`;
                        tp._sys_alert_unread = true;
                        
                        await env.DB.prepare("UPDATE workspace SET status = ?, task_progress = ? WHERE id = ?").bind(freshStatus, JSON.stringify(tp), bill.id).run();
                        bill.status = freshStatus; 
                        bill.task_progress = JSON.stringify(tp); 
                        
                        // WHISPER TO SCRAPER: CHECK FOR SUBSTITUTE BILL TEXT!
                        ctx.waitUntil(
                          fetch("https://legitile-scraper.ewing-jacob.workers.dev/add-to-queue", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ bill_number: bill.bill_number, biennium: bill.biennium })
                          }).catch(() => {})
                        );
                    }
                } catch (e) { console.log(`Refresh failed for ${bill.bill_number}`); }
                return bill;
            });
            const updatedResults = await Promise.all(refreshBills);
            return new Response(JSON.stringify(updatedResults), { headers });
        } else {
            return new Response(JSON.stringify(results), { headers });
        }
      } catch (e) { return new Response("Database error", { status: 500, headers }); }
    }

    if (path === "/templates" && request.method === "GET") {
      try {
        const { results } = await env.DB.prepare("SELECT * FROM user_templates WHERE user_email = ?").bind(userEmail).all();
        return new Response(JSON.stringify(results), { headers });
      } catch (e) { return new Response("Database error", { status: 500, headers }); }
    }

    if (path === "/save-template" && request.method === "POST") {
      try {
        const data = await request.json();
        await env.DB.prepare(`
          INSERT INTO user_templates (user_email, committee, stage, tasks) 
          VALUES (?, ?, ?, ?) 
          ON CONFLICT(user_email, committee, stage) DO UPDATE SET tasks = excluded.tasks
        `).bind(userEmail, data.committee, data.stage, JSON.stringify(data.tasks)).run();
        return new Response(JSON.stringify({ success: true }), { headers });
      } catch (e) { return new Response("Database error", { status: 500, headers }); }
    }

    if (path === "/trash" && request.method === "GET") {
      try {
        const { results } = await env.DB.prepare("SELECT * FROM workspace WHERE user_email = ? AND is_deleted = 1 ORDER BY added_on DESC").bind(userEmail).all();
        return new Response(JSON.stringify(results), { headers });
      } catch (e) { return new Response("Database error", { status: 500, headers }); }
    }

    if (path === "/restore-bill" && request.method === "POST") {
      try {
        const data = await request.json();
        await env.DB.prepare("UPDATE workspace SET is_deleted = 0 WHERE id = ? AND user_email = ?").bind(data.id, userEmail).run();
        return new Response(JSON.stringify({ success: true }), { headers });
      } catch (e) { return new Response("Database error", { status: 500, headers }); }
    }

    if (path === "/empty-trash" && request.method === "DELETE") {
      try {
        await env.DB.prepare("DELETE FROM workspace WHERE user_email = ? AND is_deleted = 1").bind(userEmail).run();
        return new Response(JSON.stringify({ success: true }), { headers });
      } catch (e) { return new Response("Database error", { status: 500, headers }); }
    }

    return new Response("Not Found", { status: 404, headers });
  },
  
  async scheduled(event, env, ctx) {
    try {
      const activeBienniums = await env.DB.prepare("SELECT name FROM bienniums WHERE is_active = 1").all();
      const activeSessionNames = activeBienniums.results.map(b => b.name);

      if (activeSessionNames.length === 0) return; 

      const { results: bills } = await env.DB.prepare("SELECT * FROM workspace WHERE is_deleted = 0 AND type = 'live'").all();

      for (const bill of bills) {
        if (!activeSessionNames.includes(bill.biennium)) continue; 

        try {
          const res = await fetch(`https://wslwebservices.leg.wa.gov/LegislationService.asmx`, {
            method: "POST",
            headers: { "Content-Type": "text/xml; charset=utf-8", "SOAPAction": "http://WSLWebServices.leg.wa.gov/GetCurrentStatus" },
            body: `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><GetCurrentStatus xmlns="http://WSLWebServices.leg.wa.gov/"><biennium>${bill.biennium}</biennium><billNumber>${bill.bill_number}</billNumber></GetCurrentStatus></soap:Body></soap:Envelope>`
          });
          
          const xmlText = await res.text();
          const statusMatch = xmlText.match(/<HistoryLine>(.*?)<\/HistoryLine>/i);
          const freshStatus = statusMatch ? statusMatch[1].trim() : bill.status;

          if (freshStatus !== bill.status) {
            let tp = {};
            try { tp = JSON.parse(bill.task_progress || "{}"); } catch(e) {}
            tp._sys_alert = `Status changed to: ${freshStatus}`;
            tp._sys_alert_unread = true;
            
            await env.DB.prepare("UPDATE workspace SET status = ?, task_progress = ? WHERE id = ?").bind(freshStatus, JSON.stringify(tp), bill.id).run();
            
            // WHISPER TO SCRAPER: CHECK FOR SUBSTITUTE BILL TEXT!
            ctx.waitUntil(
              fetch("https://legitile-scraper.ewing-jacob.workers.dev/add-to-queue", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ bill_number: bill.bill_number, biennium: bill.biennium })
              }).catch(() => {})
            );
          }
        } catch (apiError) {
          console.error(`Cron refresh failed for bill ${bill.bill_number}:`, apiError);
        }
      }
    } catch (dbError) {
      console.error("Cron execution failed:", dbError);
    }
  }
};
