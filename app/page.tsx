export default function Home() {
  return (
    <main style={{ minHeight: '100dvh', background: '#0A0A0C', color: '#F5F5F7',
      fontFamily: 'system-ui, sans-serif', display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24, textAlign: 'center' }}>
      <div style={{ fontSize: 40, fontWeight: 800, letterSpacing: -1.5 }}>
        Kira<span style={{ color: '#12CF7A' }}>.</span>
      </div>
      <p style={{ color: '#8E8E97', maxWidth: 360 }}>
        Snap. Split. Settled. Open a group invite link to join.
      </p>
    </main>
  )
}
