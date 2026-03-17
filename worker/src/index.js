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
        // 타임스탬프를 키에 포함하여 시간 순으로 정렬하기 쉽게 저장
        const targetTime = new Date(schedule.dateTime).getTime();
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

    return new Response("Threads Cloud Server is Running", { status: 200 });
  },

  // 3. 1분마다 실행되는 스케줄러 (CRON Trigger)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduler(env));
  }
};

async function handleScheduler(env) {
  const now = Date.now();
  // 모든 예약 리스트 가져오기 (prefix 'sch:')
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
        
        const result = await uploadToThreads(schedule);
        
        if (result.success) {
          // 성공 시 히스토리로 이동 후 예약 삭제
          await env.SCHEDULES_KV.delete(key);
          await env.SCHEDULES_KV.put(`history:${schedule.id}`, JSON.stringify({
            ...schedule,
            status: 'completed',
            completedAt: new Date().toISOString(),
            mediaId: result.mediaId
          }), { expirationTtl: 60 * 60 * 24 * 30 }); // 30일 후 자동 삭제
        } else {
          // 실패 시 상태 업데이트 (로그 기록)
          schedule.status = 'failed';
          schedule.error = result.message;
          await env.SCHEDULES_KV.put(key, JSON.stringify(schedule));
        }
      }
    }
  }
}

/**
 * Threads API 업로드 로직 (로컬 uploader.js의 워커 버전)
 */
async function uploadToThreads(data) {
  const { content, imagePath, accessToken, threadsUserId } = data;
  const API_BASE = 'https://graph.threads.net/v1.0';

  try {
    let containerId;
    const isCarousel = Array.isArray(imagePath) && imagePath.length > 1;
    const hasMedia = imagePath && (Array.isArray(imagePath) ? imagePath.length > 0 : true);

    if (!hasMedia) {
      // 1. 텍스트만 업로드
      const res = await threadsApiCall(`${API_BASE}/${threadsUserId}/threads`, {
        media_type: 'TEXT',
        text: content,
        access_token: accessToken
      });
      containerId = res.id;
    } else if (isCarousel) {
      // 2. 캐러셀 업로드 (다중 이미지)
      const childIds = [];
      for (const url of imagePath.slice(0, 10)) {
        const isVideo = url.toLowerCase().includes('.mp4');
        const childRes = await threadsApiCall(`${API_BASE}/${threadsUserId}/threads`, {
          media_type: isVideo ? 'VIDEO' : 'IMAGE',
          [isVideo ? 'video_url' : 'image_url']: url,
          is_carousel_item: 'true',
          access_token: accessToken
        });
        childIds.push(childRes.id);
      }
      
      // 처리 대기 (워커에서는 간단히 10초 대기)
      await new Promise(r => setTimeout(r, 10000));

      const carRes = await threadsApiCall(`${API_BASE}/${threadsUserId}/threads`, {
        media_type: 'CAROUSEL',
        children: childIds.join(','),
        text: content,
        access_token: accessToken
      });
      containerId = carRes.id;
    } else {
      // 3. 단일 미디어 업로드
      const url = Array.isArray(imagePath) ? imagePath[0] : imagePath;
      const isVideo = url.toLowerCase().includes('.mp4');
      const res = await threadsApiCall(`${API_BASE}/${threadsUserId}/threads`, {
        media_type: isVideo ? 'VIDEO' : 'IMAGE',
        [isVideo ? 'video_url' : 'image_url']: url,
        text: content,
        access_token: accessToken
      });
      containerId = res.id;
    }

    if (!containerId) throw new Error("컨테이너 생성 실패");

    // 처리 대기 후 발행
    await new Promise(r => setTimeout(r, 8000));
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

async function threadsApiCall(url, params) {
  const query = new URLSearchParams(params).toString();
  const res = await fetch(`${url}?${query}`, { method: 'POST' });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  return json;
}
