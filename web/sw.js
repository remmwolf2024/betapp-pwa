const WORKER_BASE = "https://betapp-pwa.remmwolf2024.workers.dev";

self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    let title = "Bildirim";
    let body = "Yeni bildirim var.";

    try {
      const res = await fetch(WORKER_BASE + "/lastCampaign", { cache: "no-store" });
      const data = await res.json();
      title = data.title || title;
      body = data.body || body;
    } catch (e) {
      // fallback
    }

    await self.registration.showNotification(title, {
      body,
      icon: "/icon.png",
      badge: "/icon.png",
      tag: "betapp",
      renotify: true,
    });
  })());
});
