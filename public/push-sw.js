// Phone notifications: shows an alert sent by the BiteBY server, and opens
// the right page when it's tapped. Loaded into the app's service worker.
self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = { title: 'BiteBY', body: event.data ? event.data.text() : '' }
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'BiteBY', {
      body: data.body || '',
      icon: '/icon-192.png',
      badge: '/favicon-64.png',
      tag: data.tag,
      data: { link: data.link || '/alerts' },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const link = (event.notification.data && event.notification.data.link) || '/alerts'
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((tabs) => {
      for (const tab of tabs) {
        if (new URL(tab.url).origin === self.location.origin && 'focus' in tab) {
          tab.navigate(link)
          return tab.focus()
        }
      }
      return self.clients.openWindow(link)
    }),
  )
})
