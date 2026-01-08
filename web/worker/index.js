export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ---------------- CORS ----------------
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    // ---------------- Helpers ----------------
    const te = new TextEncoder();

    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj), {
        status,
        headers: { ...cors, "Content-Type": "application/json; charset=utf-8" },
      });

    const text = (s, status = 200) =>
      new Response(s, { status, headers: { ...cors, "Content-Type": "text/plain; charset=utf-8" } });

    const now = () => Date.now();

    const safeString = (s, max) => (typeof s === "string" ? s.slice(0, max) : "");

    const normalizeId = (s, max = 80) => {
      s = (s || "").toString().trim();
      s = s.replace(/[^\w\-:]/g, "");
      return s.slice(0, max);
    };

    const b64urlEncode = (u8) => {
      let s = "";
      for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
      return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    };

    const b64urlDecode = (s) => {
      s = (s || "").trim().replace(/-/g, "+").replace(/_/g, "/");
      const pad = "=".repeat((4 - (s.length % 4)) % 4);
      const bin = atob(s + pad);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    };

    const concat = (...arrs) => {
      const len = arrs.reduce((a, b) => a + b.length, 0);
      const out = new Uint8Array(len);
      let o = 0;
      for (const a of arrs) {
        out.set(a, o);
        o += a.length;
      }
      return out;
    };

    // ---------------- Admin Auth (Basic) ----------------
    const unauthorized = () =>
      new Response("Unauthorized", {
        status: 401,
        headers: { ...cors, "WWW-Authenticate": 'Basic realm="BetApp Admin"' },
      });

    const isAdmin = (req) => {
      const h = req.headers.get("authorization") || "";
      if (!h.startsWith("Basic ")) return false;
      const raw = h.slice(6);
      let decoded = "";
      try {
        decoded = atob(raw);
      } catch {
        return false;
      }
      const [u, p] = decoded.split(":");
      return u === env.ADMIN_USER && p === env.ADMIN_PASS;
    };

    // ---------------- VAPID JWT (ES256) ----------------
    const sigToJose = (sig) => {
      if (sig.length === 64) return sig;

      let p = 0;
      const readLen = () => {
        let len = sig[p++];
        if (len < 0x80) return len;
        const n = len & 0x7f;
        let out = 0;
        for (let i = 0; i < n; i++) out = (out << 8) | sig[p++];
        return out;
      };

      if (sig[p++] !== 0x30) throw new Error("Bad DER");
      readLen();

      if (sig[p++] !== 0x02) throw new Error("Bad DER");
      const rLen = readLen();
      let r = sig.slice(p, p + rLen);
      p += rLen;

      if (sig[p++] !== 0x02) throw new Error("Bad DER");
      const sLen = readLen();
      let s = sig.slice(p, p + sLen);

      const strip = (x) => {
        while (x.length > 0 && x[0] === 0x00) x = x.slice(1);
        return x;
      };
      r = strip(r);
      s = strip(s);

      const rOut = new Uint8Array(32);
      const sOut = new Uint8Array(32);
      rOut.set(r, 32 - r.length);
      sOut.set(s, 32 - s.length);
      return concat(rOut, sOut);
    };

    const importVapidPrivateKey = async () => {
      const d = b64urlDecode(env.VAPID_PRIVATE_KEY);
      const pub = b64urlDecode(env.VAPID_PUBLIC_KEY);
      const x = pub.slice(1, 33);
      const y = pub.slice(33, 65);

      const jwk = {
        kty: "EC",
        crv: "P-256",
        x: b64urlEncode(x),
        y: b64urlEncode(y),
        d: b64urlEncode(d),
        ext: true,
      };

      return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    };

    const createVapidJWT = async (aud) => {
      const header = b64urlEncode(te.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
      const payload = b64urlEncode(
        te.encode(
          JSON.stringify({
            aud,
            exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
            sub: env.VAPID_CONTACT || "mailto:admin@example.com",
          })
        )
      );

      const data = te.encode(`${header}.${payload}`);
      const key = await importVapidPrivateKey();
      const sigRawOrDer = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, data));
      const sigJose = sigToJose(sigRawOrDer);
      const sig = b64urlEncode(sigJose);

      return `${header}.${payload}.${sig}`;
    };

    // ---------------- Push (NO PAYLOAD) ----------------
    const sendWakePush = async (subscription) => {
      const endpoint = subscription?.endpoint;
      if (!endpoint) throw new Error("Bad subscription");
      const aud = new URL(endpoint).origin;
      const jwt = await createVapidJWT(aud);

      const headers = {
        Authorization: `WebPush ${jwt}`,
        "Crypto-Key": `p256ecdsa=${env.VAPID_PUBLIC_KEY}`,
        TTL: "2419200",
      };

      return fetch(endpoint, { method: "POST", headers });
    };

    // ---------------- KV keys ----------------
    const userKey = (deviceId) => `user:${deviceId}`;
    const subKey = (deviceId) => `sub:${deviceId}`;

    // ---------------- Routes ----------------

    if (url.pathname === "/vapidPublicKey" && request.method === "GET") {
      return text(env.VAPID_PUBLIC_KEY);
    }

    if (url.pathname === "/upsertUser" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));

      const deviceId = normalizeId(body.deviceId, 120);
      const username = safeString(body.username, 64).trim().replace(/\s+/g, "");
      if (!deviceId || !username) return text("deviceId + username required", 400);

      const key = userKey(deviceId);
      const prevRaw = await env.BETAPP_KV.get(key);
      const prev = prevRaw ? JSON.parse(prevRaw) : {};

      const next = {
        deviceId,
        username,
        platform: safeString(body.platform, 32),
        browser: safeString(body.browser, 32),
        installed: !!body.installed,
        permission: safeString(body.permission, 16),
        subscribed: !!body.subscribed,
        last_seen: now(),
        first_seen: prev.first_seen || now(),
      };

      await env.BETAPP_KV.put(key, JSON.stringify(next));
      return json({ ok: true });
    }

    if (url.pathname === "/subscribe" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const deviceId = normalizeId(body.deviceId, 120);
      const username = safeString(body.username, 64).trim().replace(/\s+/g, "");
      const subscription = body.subscription;

      if (!deviceId || !username || !subscription) return text("missing", 400);

      await env.BETAPP_KV.put(subKey(deviceId), JSON.stringify(subscription));

      const uKey = userKey(deviceId);
      const prevRaw = await env.BETAPP_KV.get(uKey);
      const prev = prevRaw ? JSON.parse(prevRaw) : { deviceId, first_seen: now() };

      prev.username = username;
      prev.subscribed = true;
      prev.permission = "granted";
      prev.last_seen = now();

      await env.BETAPP_KV.put(uKey, JSON.stringify(prev));
      return text("Kaydedildi");
    }

    if (url.pathname === "/lastCampaign" && request.method === "GET") {
      const raw = await env.BETAPP_KV.get("lastCampaign");
      return json(raw ? JSON.parse(raw) : { title: "Bildirim", body: "", ts: 0 });
    }

    // ---------------- ADMIN: users page list ----------------
    if (url.pathname === "/users" && request.method === "GET") {
      if (!isAdmin(request)) return unauthorized();

      const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10), 200);
      const cursor = url.searchParams.get("cursor") || undefined;

      const page = await env.BETAPP_KV.list({ prefix: "user:", cursor, limit });

      const users = [];
      for (const k of page.keys) {
        const raw = await env.BETAPP_KV.get(k.name);
        if (!raw) continue;
        try { users.push(JSON.parse(raw)); } catch {}
      }

      users.sort((a, b) => (b.last_seen || 0) - (a.last_seen || 0));

      return json({
        users,
        cursor: page.list_complete ? null : page.cursor,
      });
    }

    // ---------------- ADMIN: search (ALL PAGES) ----------------
    // GET /search?username=abc
    if (url.pathname === "/search" && request.method === "GET") {
      if (!isAdmin(request)) return unauthorized();

      const q = (url.searchParams.get("username") || "").trim().toLowerCase();
      if (!q) return json({ users: [] });

      const maxResults = Math.min(parseInt(url.searchParams.get("limit") || "50", 10), 200);

      let cursor = undefined;
      const found = [];

      while (true) {
        const page = await env.BETAPP_KV.list({ prefix: "user:", cursor, limit: 1000 });
        for (const k of page.keys) {
          const raw = await env.BETAPP_KV.get(k.name);
          if (!raw) continue;
          let u;
          try { u = JSON.parse(raw); } catch { continue; }

          const uname = (u.username || "").toString().toLowerCase();
          if (uname.includes(q)) {
            found.push(u);
            if (found.length >= maxResults) break;
          }
        }
        if (found.length >= maxResults) break;
        if (!page.list_complete) cursor = page.cursor;
        else break;
      }

      found.sort((a, b) => (b.last_seen || 0) - (a.last_seen || 0));
      return json({ users: found });
    }

    // ---------------- ADMIN: send ----------------
    if (url.pathname === "/send" && request.method === "POST") {
      if (!isAdmin(request)) return unauthorized();

      const body = await request.json().catch(() => ({}));
      const title = safeString(body.title || "", 40);
      const msg = safeString(body.body || "", 120);

      const campaign = { title: title || "Bildirim", body: msg || "", ts: now() };
      await env.BETAPP_KV.put("lastCampaign", JSON.stringify(campaign));

      let cursor = undefined;
      let ok = 0;
      let fail = 0;
      const errors = [];

      while (true) {
        const page = await env.BETAPP_KV.list({ prefix: "sub:", cursor, limit: 1000 });

        for (const k of page.keys) {
          const raw = await env.BETAPP_KV.get(k.name);
          if (!raw) continue;

          try {
            const sub = JSON.parse(raw);
            const res = await sendWakePush(sub);

            if (res.ok) {
              ok++;
            } else {
              fail++;
              const txt = await res.text().catch(() => "");
              errors.push({ key: k.name, status: res.status, body: txt.slice(0, 120) });

              if (res.status === 404 || res.status === 410) {
                await env.BETAPP_KV.delete(k.name);

                const deviceId = k.name.slice(4); // sub:
                const uKey = userKey(deviceId);
                const uRaw = await env.BETAPP_KV.get(uKey);
                if (uRaw) {
                  const u = JSON.parse(uRaw);
                  u.subscribed = false;
                  await env.BETAPP_KV.put(uKey, JSON.stringify(u));
                }
              }
            }
          } catch (e) {
            fail++;
            errors.push({ key: k.name, status: 0, body: String(e).slice(0, 120) });
          }
        }

        if (!page.list_complete) cursor = page.cursor;
        else break;
      }

      return json({ success: true, ok, fail, errors });
    }

    return text("OK");
  },
};
