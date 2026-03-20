export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    const authHeader = request.headers.get("Authorization");
    if (authHeader !== `Bearer ${env.API_SECRET}`) {
      return new Response(JSON.stringify({ success: false, message: "Unauthorized" }), { 
        status: 401,
        headers: { "Content-Type": "application/json" }
      });
    }

    if (request.method === "POST" && url.pathname === "/add-schedule") {
      try {
        const schedule = await request.json();
        
        let dateTimeStr = schedule.dateTime;
        if (dateTimeStr && !dateTimeStr.includes('Z') && !dateTimeStr.includes('+')) {
          dateTimeStr += "+09:00";
        }

        const targetTime = new Date(dateTimeStr).getTime();
        const key = `sch:${targetTime}:${schedule.id}`;
        
        await env.SCHEDULES_KV.put(key, JSON.stringify({
          ...schedule,
          status: 'pending'
        }));
        
        return new Response(JSON.stringify({ success: true, message: "Cloudflare 예약 등록 완료" }), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (e) {
        return new Response(JSON.stringify({ success: false, message: e.message }), { status: 500 });
      }
    }

    if (request.method === "POST" && url.pathname === "/delete-schedule") {
      try {
        const { id, dateTime } = await request.json();
        let dateTimeStr = dateTime;
        if (dateTimeStr && !dateTimeStr.includes('Z') && !dateTimeStr.includes('+')) {
          dateTimeStr += "+09:00";
        }
        const targetTime = new Date(dateTimeStr).getTime();
        await env.SCHEDULES_KV.delete(`sch:${targetTime}:${id}`);
        return new Response(JSON.stringify({ success: true }));
      } catch (e) {
        return new Response(JSON.stringify({ success: false, message: e.message }), { status: 500 });
      }
    }

    if (request.method === "GET" && url.pathname === "/list-schedules") {
      const list = await env.SCHEDULES_KV.list({ prefix: "sch:" });
      const results = [];
      for (const k of list.keys) {
        const val = await env.SCHEDULES_KV.get(k.name, { type: "json" });
        if (val) results.push(val);
      }
      return new Response(JSON.stringify({ success: true, schedules: results }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    return new Response("Threads Cloud Server is Running", { status: 200 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduler(env));
  }
};

async function handleScheduler(env) {
  const now = Date.now();
  const list = await env.SCHEDULES_KV.list({ prefix: "sch:" });
  
  for (const keyObj of list.keys) {
    const key = keyObj.name;
    const parts = key.split(':');
    const scheduledTime = parseInt(parts[1]);
    
    if (scheduledTime <= now) {
      const schedule = await env.SCHEDULES_KV.get(key, { type: "json" });
      if (schedule && (schedule.status === 'pending' || schedule.status === 'active')) {
        schedule.status = 'processing';
        await env.SCHEDULES_KV.put(key, JSON.stringify(schedule));

        const result = await uploadToThreads(schedule);
        
        if (result.success) {
          await env.SCHEDULES_KV.delete(key);
          await env.SCHEDULES_KV.put(`history:${schedule.id}`, JSON.stringify({
            ...schedule,
            status: 'completed',
            completedAt: new Date().toISOString(),
            mediaId: result.mediaId
          }), { expirationTtl: 60 * 60 * 24 * 30 });
        } else {
          schedule.status = 'failed';
          schedule.error = result.message;
          await env.SCHEDULES_KV.put(key, JSON.stringify(schedule));
        }
      }
    }
  }
}

async function uploadToThreads(data) {
  const { content, imagePath, accessToken, threadsUserId } = data;
  const API_BASE = 'https://graph.threads.net/v1.0';

  try {
    let containerId;
    const isCarousel = Array.isArray(imagePath) && imagePath.length > 1;
    const hasMedia = imagePath && (Array.isArray(imagePath) ? imagePath.length > 0 : true);

    if (!hasMedia) {
      const res = await threadsApiCall(`${API_BASE}/${threadsUserId}/threads`, {
        media_type: 'TEXT',
        text: content,
        access_token: accessToken
      });
      containerId = res.id;
    } else if (isCarousel) {
      // 10개 제한 적용 (Threads API 공식 한도)
      const mediaUrls = imagePath.slice(0, 10);
      const childPromises = mediaUrls.map(async (url) => {
        const isVideo = url.toLowerCase().match(/\.(mp4|mov|m4v)/i);
        const childRes = await threadsApiCall(`${API_BASE}/${threadsUserId}/threads`, {
          media_type: isVideo ? 'VIDEO' : 'IMAGE',
          [isVideo ? 'video_url' : 'image_url']: url,
          is_carousel_item: 'true',
          access_token: accessToken
        });
        
        await waitForMediaProcessing(childRes.id, accessToken);
        return childRes.id;
      });

      const childIds = await Promise.all(childPromises);
      
      const carRes = await threadsApiCall(`${API_BASE}/${threadsUserId}/threads`, {
        media_type: 'CAROUSEL',
        children: childIds.join(','),
        text: content,
        access_token: accessToken
      });
      containerId = carRes.id;
    } else {
      const url = Array.isArray(imagePath) ? imagePath[0] : imagePath;
      const isVideo = url.toLowerCase().match(/\.(mp4|mov|m4v)/i);
      const res = await threadsApiCall(`${API_BASE}/${threadsUserId}/threads`, {
        media_type: isVideo ? 'VIDEO' : 'IMAGE',
        [isVideo ? 'video_url' : 'image_url']: url,
        text: content,
        access_token: accessToken
      });
      containerId = res.id;
    }

    if (!containerId) throw new Error("컨테이너 생성 실패");

    await waitForMediaProcessing(containerId, accessToken);
    
    const publish = await threadsApiCall(`${API_BASE}/${threadsUserId}/threads_publish`, {
      creation_id: containerId,
      access_token: accessToken
    });

    return { success: true, mediaId: publish.id };

  } catch (e) {
    console.error("Upload error:", e.message);
    return { success: false, message: e.message };
  }
}

async function waitForMediaProcessing(containerId, accessToken) {
  const API_BASE = 'https://graph.threads.net/v1.0';
  let attempts = 0;
  const maxAttempts = 15;

  while (attempts < maxAttempts) {
    const res = await fetch(`${API_BASE}/${containerId}?fields=status,error_message&access_token=${accessToken}`);
    const data = await res.json();
    
    if (data.status === 'FINISHED') return true;
    if (data.status === 'ERROR') throw new Error(data.error_message || "미디어 처리 중");
    
    attempts++;
    await new Promise(r => setTimeout(r, 3000));
  }
  return true;
}

async function threadsApiCall(url, params) {
  const query = new URLSearchParams(params).toString();
  const res = await fetch(`${url}?${query}`, { method: 'POST' });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  return json;
}
