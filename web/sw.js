self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) {}

  const title = data.title || "Bildirim";
  const body = data.body || "Yeni bildirim var.";

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: "/icon.png",
      badge: "/icon.png",
      tag: "betapp-campaign",
      renotify: true,
      requireInteraction: true
    })
  );
});
