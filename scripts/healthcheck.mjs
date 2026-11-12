const url = new URL(process.env.CLOUD_HEALTH_ORIGIN || 'http://127.0.0.1:18991');
if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/' || url.username || url.password || url.search || url.hash) throw new Error('health check requires a loopback worker origin');
try {
  const response = await fetch(url.origin + '/healthz', { redirect: 'error', signal: AbortSignal.timeout(5000) });
  const value = await response.json();
  console.log(JSON.stringify({ app: 'donebot-cloud-health', ready: response.ok && value.ready === true, master: value.master === true, agent: value.agent === true }));
  if (!response.ok || value.ready !== true) process.exitCode = 1;
} catch { console.log(JSON.stringify({ app: 'donebot-cloud-health', ready: false })); process.exitCode = 1; }
