export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // 보안 체크: 설정된 API_SECRET과 일치해야 함
    const authHeader = request.headers.get("Authorization");
    if (authHeader !== `Bearer ${env.API_SECRET}`) {
      return new Response(JSON.stringify({ success: false, message: "Unauthorized" }), { 
        status: 401,
        headers: { "Content-Type": "application/json" }
      });
    }

    // 1. 예약 수신 (로컬 앱 -> 워커)
    if (request.method === "POST" && url.pathname === "/add-schedule") {
      try {
        const schedule = await request.json();
        
        // 타임존 보정: ISO 형식이 아니고 타임존 정보가 없으면 +09:00(서울) 추가
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

    // 2. 예약 삭제
    if (request.method === "POST" && url.pathname === "/delete-schedule") {
      const { id, dateTime } = await request.json();
      const targetTime = new Date(dateTime).getTime();
      await env.SCHEDULES_KV.delete(`sch:${targetTime}:${id}`);
      return new Response(JSON.stringify({ success: true }));
    }

    // 4. 상태 확인 (로컬 앱에서 동기화용)
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

  // 3. 1분마다 실행되는 스케줄러 (CRON Trigger)
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
    
    // 예약 시간이 지났다면 실행
    if (scheduledTime <= now) {
      const schedule = await env.SCHEDULES_KV.get(key, { type: "json" });
      if (schedule && schedule.status === 'pending') {
        console.log(`[Scheduler] Executing task: ${schedule.id}`);
        
        // 상태를 'processing'으로 먼저 업데이트하여 중복 실행 방지
        schedule.status = 'processing';
        await env.SCHEDULES_KV.put(key, JSON.stringify(schedule));

        const result = await uploadToThreads(schedule);
        
        if (result.success) {
          // 성공 시 히스토리로 이동 후 예약 삭제
          await env.SCHEDULES_KV.delete(key);
          await env.SCHEDULES_KV.put(`history:${schedule.id}`, JSON.stringify({
            ...schedule,
            status: 'completed',
            completedAt: new Date().toISOString(),
            mediaId: result.mediaId
          }), { expirationTtl: 60 * 60 * 24 * 30 });
        } else {
          // 실패 시 상태 업데이트
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
      const childIds = [];
      for (const url of imagePath.slice(0, 10)) {
        const isVideo = url.toLowerCase().match(/\.(mp4|mov|m4v)/i);
        const childRes = await threadsApiCall(`${API_BASE}/${threadsUserId}/threads`, {
          media_type: isVideo ? 'VIDEO' : 'IMAGE',
          [isVideo ? 'video_url' : 'image_url']: url,
          is_carousel_item: 'true',
          access_token: accessToken
        });
        
        // 각각의 아이템이 처리될 때까지 대기
        await waitForMediaProcessing(childRes.id, accessToken);
        childIds.push(childRes.id);
      }
      
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

    // 최종 컨테이너 처리 완료 대기 후 발행
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
  const maxAttempts = 15; // 최대 약 45초 대기

  while (attempts < maxAttempts) {
    const res = await fetch(`${API_BASE}/${containerId}?fields=status,error_message&access_token=${accessToken}`);
    const data = await res.json();
    
    if (data.status === 'FINISHED') return true;
    if (data.status === 'ERROR') throw new Error(data.error_message || "미디어 처리 중 오류가 발생했습니다.");
    
    attempts++;
    await new Promise(r => setTimeout(r, 3000)); // 3초 간격
  }
  
  // 타임아웃되어도 일단 진행 시도 (때로는 Finished 직전일 수 있음)
  return true;
}

async function threadsApiCall(url, params) {
  const query = new URLSearchParams(params).toString();
  const res = await fetch(`${url}?${query}`, { method: 'POST' });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  return json;
}
