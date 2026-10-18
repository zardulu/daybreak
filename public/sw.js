// Android Chrome and iOS Home Screen apps only show notifications through a service worker.
// Clicking one brings the app back to the front.
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) =>
            windows.length > 0 ? windows[0].focus() : self.clients.openWindow('/')
        )
    );
});
