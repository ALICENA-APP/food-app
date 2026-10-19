import type { MouseEvent } from 'react'
import { link, navigate } from '../lib/router'
import { Icon, type IconName } from '../lib/icons'
import { useWelcomeHeadline } from '../lib/platform'

const SEEN_KEY = 'introSeen'

export function introSeen() {
  try {
    return localStorage.getItem(SEEN_KEY) === '1'
  } catch {
    return true
  }
}

function markSeen() {
  try {
    localStorage.setItem(SEEN_KEY, '1')
  } catch {
    // storage unavailable: the welcome screen just shows again next time
  }
}

const FEATURES: { icon: IconName; label: string }[] = [
  { icon: 'home', label: 'Homemade food' },
  { icon: 'pin', label: 'Local sellers' },
  { icon: 'heart', label: 'Trusted community' },
  { icon: 'users', label: 'Support local' },
]

// The welcome screen first-time visitors see before the home page.
export default function Intro() {
  const welcome = useWelcomeHeadline()
  const go = (to: string) => (e: MouseEvent) => {
    e.preventDefault()
    markSeen()
    navigate(to)
  }
  return (
    <div className="intro">
      <header className="intro-brand">
        <img src="/logo-word.png" alt="BiteBY" className="intro-logo" />
        <p className="intro-tagline">Good food, made by locals</p>
      </header>

      <img className="intro-hero" src="/intro-food.webp" alt="Homemade pasta bake, a chicken and grain salad, and chocolate brownies" />

      <h1 className="intro-title">Discover homemade meals, desserts and local sellers near you</h1>

      <ul className="intro-features">
        {FEATURES.map((f) => (
          <li key={f.label}><span className="ic"><Icon name={f.icon} filled={f.icon !== 'pin'} /></span>{f.label}</li>
        ))}
      </ul>

      <div className="intro-actions">
        <a className="button block intro-start" href="/signin?mode=signup" onClick={go('/signin?mode=signup')}>
          Get Started <Icon name="chevron" size={20} />
        </a>
        <a className="button secondary block" href="/signin" onClick={go('/signin')}>Sign In</a>
      </div>

      <p className="intro-or"><span>Or explore</span></p>

      <div className="intro-explore">
        <a href="/explore" onClick={go('/explore')}>
          <span className="ic"><Icon name="cutlery" /></span>
          <span><strong>Order food</strong><small>Browse homemade meals &amp; desserts</small></span>
          <Icon name="chevron" size={18} />
        </a>
        <a href="/sell" onClick={go('/sell')}>
          <span className="ic"><Icon name="store" /></span>
          <span><strong>Sell on BiteBY</strong><small>{welcome ? `${welcome} · share your food with the community` : 'Share your food with the community'}</small></span>
          <Icon name="chevron" size={18} />
        </a>
      </div>
      <a className="intro-skip" href="/" onClick={go('/')}>Just look around</a>
      <p className="intro-legal">By continuing you agree to our <a href="/terms" onClick={link('/terms')}>Terms</a> and <a href="/privacy" onClick={link('/privacy')}>Privacy</a>.</p>
    </div>
  )
}
