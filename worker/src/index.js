export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // API_SECRET security check
    const authHeader = request.headers.get("Authorization");
    if (authHeader !== `Bearer ${env.API_SECRET}`) {
      return new Response("Unauthorized", { status: 401 });
    }

    // 1. Receive schedule from Local App
    if (request.method === "POST" && url.pathname === "/add-schedule") {
      try {
        const schedule = await request.json();
        const timestamp = new Date(schedule.dateTime).getTime();
        const key = `sch:${timestamp}:${schedule.id}`;
        await env.SCHEDULES_KV.put(key, JSON.stringify(schedule));
        return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json" }});
      } catch (e) {
        return new Response(e.message, { status: 500 });
      }
    }

    // 2. Query pending schedules (for Local App UI)
    if (request.method === "GET" && url.pathname === "/list-schedules") {
      const list = await env.SCHEDULES_KV.list({ prefix: "sch:" });
      return new Response(JSON.stringify(list.keys), { headers: { "Content-Type": "application/json" }});
    }

    return new Response("Threads Scheduler Worker is Running", { status: 200 });
  },

  // The "Minute Clock" - This runs even if nobody visits the URL
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleCron(env));
  }
};

async function handleCron(env) {
  const now = Date.now();
  const list = await env.SCHEDULES_KV.list({ prefix: "sch:" });
  
  for (const keyObj of list.keys) {
    const key = keyObj.name;
    const timestamp = parseInt(key.split(':')[1]);
    
    if (timestamp <= now) {
      const data = await env.SCHEDULES_KV.get(key, { type: "json" });
      if (data && data.status !== 'completed') {
        const result = await uploadToThreads(data);
        if (result.success) {
          await env.SCHEDULES_KV.delete(key);
          await env.SCHEDULES_KV.put(`history:${data.id}`, JSON.stringify({ ...data, status: 'completed', runAt: new Date().toISOString() }));
        } else {
          // Retry later or mark failed
          data.status = 'failed';
          data.error = result.message;
          await env.SCHEDULES_KV.put(key, JSON.stringify(data));
        }
      }
    }
  }
}

async function uploadToThreads(data) {
  const { content, imagePath, accessToken, threadsUserId } = data;
  const BASE = 'https://graph.threads.net/v1.0';

  try {
    let containerId;
    const isMultiple = Array.isArray(imagePath);
    
    if (!imagePath || (isMultiple && imagePath.length === 0)) {
      const res = await fetch(`${BASE}/${threadsUserId}/threads?media_type=TEXT&text=${encodeURIComponent(content)}&access_token=${accessToken}`, { method: 'POST' });
      const json = await res.json();
      containerId = json.id;
    } else {
      // Logic for Images (Threads API requires public URLs)
      const url = isMultiple ? imagePath[0] : imagePath;
      const res = await fetch(`${BASE}/${threadsUserId}/threads?media_type=IMAGE&image_url=${encodeURIComponent(url)}&text=${encodeURIComponent(content)}&access_token=${accessToken}`, { method: 'POST' });
      const json = await res.json();
      containerId = json.id;
    }

    if (!containerId) return { success: false, message: "Container creation failed" };

    // Wait 5s for processing (simple wait for worker)
    await new Promise(r => setTimeout(r, 5000));

    const pub = await fetch(`${BASE}/${threadsUserId}/threads_publish?creation_id=${containerId}&access_token=${accessToken}`, { method: 'POST' });
    const pubJson = await pub.json();
    return pubJson.id ? { success: true } : { success: false, message: pubJson.error?.message };
  } catch (e) {
    return { success: false, message: e.message };
  }
}
