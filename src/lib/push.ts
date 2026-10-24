import { useEffect, useState } from 'react'
import { supabase } from './supabase'

// Phone notifications (web push). On iPhone they only work once BiteBY has
// been added to the Home Screen.

export type PushState = 'unsupported' | 'needs_install' | 'blocked' | 'off' | 'on' | 'not_ready'

const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent)
const isInstalled = () => window.matchMedia?.('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true

function keyBytes(b64: string) {
  const s = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(s, (c) => c.charCodeAt(0))
}

async function registration() {
  if (!('serviceWorker' in navigator)) return null
  return (await navigator.serviceWorker.getRegistration()) ?? null
}

export async function pushState(): Promise<PushState> {
  if (!('Notification' in window) || !('PushManager' in window) || !('serviceWorker' in navigator)) {
    return isIos() && !isInstalled() ? 'needs_install' : 'unsupported'
  }
  if (Notification.permission === 'denied') return 'blocked'
  const reg = await registration()
  if (!reg) return 'not_ready'
  const sub = await reg.pushManager.getSubscription()
  return sub && Notification.permission === 'granted' ? 'on' : 'off'
}

export async function turnOnPush(): Promise<PushState> {
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return permission === 'denied' ? 'blocked' : 'off'
  const reg = await navigator.serviceWorker.ready
  const { data: key, error } = await supabase!.rpc('push_public_key')
  if (error || !key) throw new Error('Phone notifications aren’t switched on yet. Please try again later.')
  const sub = (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key as string) }))
  const json = sub.toJSON()
  const { error: saveError } = await supabase!.rpc('save_push_subscription', {
    p_endpoint: sub.endpoint, p_p256dh: json.keys?.p256dh, p_auth: json.keys?.auth,
  })
  if (saveError) throw new Error(saveError.message)
  return 'on'
}

export async function turnOffPush(): Promise<PushState> {
  const sub = await (await registration())?.pushManager.getSubscription()
  if (sub) {
    await supabase!.rpc('remove_push_subscription', { p_endpoint: sub.endpoint })
    await sub.unsubscribe()
  }
  return 'off'
}

export function usePushState() {
  const [state, setState] = useState<PushState | null>(null)
  useEffect(() => {
    pushState().then(setState, () => setState('unsupported'))
  }, [])
  return [state, setState] as const
}
