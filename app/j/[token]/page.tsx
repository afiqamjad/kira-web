'use client'

import { useEffect, useState, useCallback } from 'react'
import { useParams } from 'next/navigation'
import { supabase, ensureAnonSession } from '../../../lib/supabase'
import {
  balanceFor, activityFor, paidBy, shareOf, transfersFor, fmt,
  type EventRow, type Transfer, type SettleMode,
} from '../../../lib/ledger'

type Member = {
  id: string
  person_key: string
  name: string
  color_index: number
  claimed: boolean
  claimed_by_me: boolean
}
type GroupInfo = {
  id: string
  name: string
  type: string
  default_split: string
  members: Member[]
}

const AVATAR = ['#12CF7A', '#2E8CFF', '#B45AF0', '#FFA114', '#FF375F', '#64D2FF']

export default function JoinPage() {
  const { token } = useParams<{ token: string }>()
  const [group, setGroup] = useState<GroupInfo | null>(null)
  const [events, setEvents] = useState<EventRow[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [settling, setSettling] = useState<string | null>(null)
  const [view, setView] = useState<'home' | 'settle'>('home')
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')

  const me = group?.members.find((m) => m.claimed_by_me) ?? null

  const loadGroup = useCallback(async () => {
    const { data, error } = await supabase.rpc('get_group_by_token', { p_token: token })
    if (error) { setError(error.message); return }
    if (!data) { setError('This group link is invalid or was removed.'); return }
    setGroup(data as GroupInfo)
  }, [token])

  const loadEvents = useCallback(async (groupId: string) => {
    const { data } = await supabase
      .from('events')
      .select('kind, payload, created_at')
      .eq('group_id', groupId)
      .order('created_at', { ascending: true })
    setEvents((data ?? []) as EventRow[])
  }, [])

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        await ensureAnonSession()
        await loadGroup()
      } catch (e: any) {
        if (alive) setError(e.message ?? 'Something went wrong.')
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => { alive = false }
  }, [loadGroup])

  useEffect(() => {
    if (!group) return
    if (me) loadEvents(group.id)

    const channel = supabase
      .channel(`group-${group.id}`)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'events', filter: `group_id=eq.${group.id}` },
        () => { if (me) loadEvents(group.id) })
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'group_members', filter: `group_id=eq.${group.id}` },
        () => { loadGroup() })
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [group?.id, me?.person_key, loadEvents, loadGroup])

  async function claim(person_key: string) {
    setBusy(true); setError(null)
    const { data, error } = await supabase.rpc('claim_member', { p_token: token, p_person_key: person_key })
    setBusy(false)
    if (error) { setError(error.message); return }
    if (!data?.ok) {
      setError(data?.error === 'slot_taken' ? 'Someone just took that name. Pick another.' : 'Could not claim that name.')
    }
    await loadGroup()
  }

  // "I'm not listed": add a brand-new member and claim it in one step.
  async function addSelf() {
    const name = newName.trim()
    if (!name) return
    setBusy(true); setError(null)
    const { data, error } = await supabase.rpc('add_self_member', { p_token: token, p_name: name })
    setBusy(false)
    if (error) { setError(error.message); return }
    if (!data?.ok) {
      setError(
        data?.error === 'name_taken' ? 'That name is already in the group. If it\u2019s you, pick it from the list.'
        : data?.error === 'already_claimed' ? 'You\u2019ve already picked a name in this group.'
        : 'Could not add you. Try again.'
      )
      return
    }
    setAdding(false); setNewName('')
    await loadGroup()
  }

  async function disconnect() {
    if (!group) return
    setBusy(true)
    await supabase.rpc('release_member', { p_group_id: group.id })
    setEvents([])
    setBusy(false)
    await loadGroup()
  }

  // Mark a settle-up transfer as paid (from the Settle up page). Works both
  // ways: "I paid them" or "they paid me". The app picks it up like any other
  // settle-up, so balances everywhere update.
  async function markPaid(t: Transfer) {
    if (!group || !me || t.sen <= 0) return
    const key = `${t.from}>${t.to}`
    setSettling(key); setError(null)
    const { error } = await supabase.from('events').insert({
      group_id: group.id,
      kind: 'settled',
      payload: { from: t.from, to: t.to, sen: t.sen, confirmedAt: new Date().toISOString() },
    })
    setSettling(null)
    if (error) { setError(error.message); return }
    await loadEvents(group.id)   // realtime also refreshes, this makes it instant
  }

  if (loading) return <Shell><p style={{ color: '#8E8E97' }}>Loading…</p></Shell>
  if (error && !group) return <Shell><p style={{ color: '#FF4438' }}>{error}</p></Shell>
  if (!group) return <Shell><p style={{ color: '#8E8E97' }}>Not found.</p></Shell>

  return (
    <Shell>
      <div style={{ textAlign: 'center', marginBottom: 20 }}>
        <div style={brand}>Kira<span style={{ color: '#12CF7A' }}>.</span></div>
        <h1 style={{ fontSize: 24, fontWeight: 800, margin: '14px 0 4px' }}>{group.name}</h1>
        <div style={{ color: '#8E8E97', fontSize: 13, textTransform: 'capitalize' }}>{group.type} group</div>
      </div>

      {error && <div style={errorBox}>{error}</div>}

      {!me ? (
        <>
          <p style={{ color: '#B9B9C2', fontSize: 14, textAlign: 'center', marginBottom: 14 }}>
            Who are you? Pick your name — it stays linked to you on this device.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {group.members.map((m) => (
              <button
                key={m.id}
                disabled={m.claimed || busy}
                onClick={() => claim(m.person_key)}
                style={{ ...memberRow, opacity: m.claimed ? 0.45 : 1, cursor: m.claimed ? 'default' : 'pointer' }}
              >
                <Avatar name={m.name} idx={m.color_index} />
                <span style={{ fontWeight: 600, flex: 1, textAlign: 'left' }}>{m.name}</span>
                {m.claimed ? <span style={{ color: '#8E8E97', fontSize: 12, fontWeight: 700 }}>Taken</span>
                           : <span style={{ color: '#8E8E97' }}>›</span>}
              </button>
            ))}

            {!adding ? (
              <button onClick={() => setAdding(true)} disabled={busy} style={notListedBtn}>
                <span style={{ fontWeight: 600 }}>I&rsquo;m not listed</span>
                <span style={{ color: '#8E8E97', fontSize: 12 }}>Add me to the group</span>
              </button>
            ) : (
              <form
                onSubmit={(ev) => { ev.preventDefault(); addSelf() }}
                style={{ ...card, display: 'flex', flexDirection: 'column', gap: 10 }}
              >
                <label htmlFor="new-name" style={{ fontSize: 13, fontWeight: 600 }}>Your name</label>
                <input
                  id="new-name" autoFocus value={newName} maxLength={60}
                  onChange={(ev) => setNewName(ev.target.value)}
                  placeholder="e.g. Aisha" autoComplete="given-name"
                  style={nameInput}
                />
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="button" onClick={() => { setAdding(false); setNewName('') }} style={cancelBtn}>
                    Cancel
                  </button>
                  <button type="submit" disabled={busy || !newName.trim()}
                    style={{ ...joinBtn, opacity: busy || !newName.trim() ? 0.5 : 1 }}>
                    Join
                  </button>
                </div>
                <div style={{ color: '#8E8E97', fontSize: 11.5 }}>
                  The group owner will see you joined and can rename or merge you.
                </div>
              </form>
            )}
          </div>
        </>
      ) : (
        view === 'settle' ? (
          <SettlePanel
            group={group} me={me} events={events}
            onBack={() => setView('home')}
            onMarkPaid={markPaid} settling={settling}
          />
        ) : (
          <MemberPanel
            group={group} me={me} events={events}
            onDisconnect={disconnect} busy={busy}
            onOpenSettle={() => setView('settle')}
          />
        )
      )}
    </Shell>
  )
}

function MemberPanel({ group, me, events, onDisconnect, busy, onOpenSettle }:
  { group: GroupInfo; me: Member; events: EventRow[]; onDisconnect: () => void; busy: boolean;
    onOpenSettle: () => void }) {
  const bal = balanceFor(events, me.person_key)
  const activity = activityFor(events, me.person_key)

  return (
    <>
      <div style={{ ...card, display: 'flex', alignItems: 'center', gap: 11, marginBottom: 12 }}>
        <Avatar name={me.name} idx={me.color_index} />
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 700, fontSize: 14 }}>You&rsquo;re {me.name}</div>
          <div style={{ color: '#8E8E97', fontSize: 11 }}>in {group.name}</div>
        </div>
        <button onClick={onDisconnect} disabled={busy}
          style={{ background: 'none', border: 'none', color: '#FFA114', fontWeight: 600, fontSize: 12, cursor: 'pointer' }}>
          Disconnect
        </button>
      </div>

      <div style={{ ...card, marginBottom: 16 }}>
        <div style={{ color: '#8E8E97', fontSize: 12 }}>
          {bal > 0 ? 'You are owed' : bal < 0 ? 'You owe' : "You're all settled up"}
        </div>
        <div style={{ fontSize: 28, fontWeight: 800, marginTop: 2,
          color: bal > 0 ? '#12CF7A' : bal < 0 ? '#FFA114' : '#fff' }}>
          {bal === 0 ? 'RM 0.00' : fmt(Math.abs(bal))}
        </div>
        <button onClick={onOpenSettle} style={settleUpBtn}>Settle up</button>
      </div>

      <div style={{ color: '#8E8E97', fontSize: 11, fontWeight: 800, letterSpacing: 0.5, marginBottom: 8 }}>
        YOUR ACTIVITY
      </div>
      {activity.length === 0 ? (
        <p style={{ color: '#8E8E97', fontSize: 14 }}>You&rsquo;re not part of any expense here yet.</p>
      ) : (
        <div style={card}>
          {activity.map((e, i) => (
            <div key={e.id} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '11px 0',
              borderBottom: i < activity.length - 1 ? '1px solid #1C1C22' : 'none' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600 }}>{e.merchant}</div>
                <div style={{ color: '#8E8E97', fontSize: 11 }}>
                  {new Date(e.occurredAt).toLocaleString('en-MY', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}
                  {' · '}{paidBy(e, me.person_key) ? 'you paid' : 'your share'}
                </div>
              </div>
              <div style={{ fontWeight: 700, fontSize: 13, flexShrink: 0 }}>
                {fmt(shareOf(e, me.person_key) || 0)}
              </div>
            </div>
                    ))}
        </div>
      )}
    </>
  )
}

// Settle up: Simplified or Direct, showing only transfers that involve you.
const MODES: { key: SettleMode; label: string; note: string }[] = [
  { key: 'simplified', label: 'Simplified',
    note: 'Fewest transfers. Someone may pay a person they didn\u2019t share an expense with.' },
  { key: 'direct', label: 'Direct', note: 'Each pair settles only what they owe each other.' },
]

function SettlePanel({ group, me, events, onBack, onMarkPaid, settling }:
  { group: GroupInfo; me: Member; events: EventRow[]; onBack: () => void;
    onMarkPaid: (t: Transfer) => void; settling: string | null }) {
  const storageKey = `kira.settleMode.${group.id}`
  const [mode, setMode] = useState<SettleMode>(() => {
    try {
      const saved = typeof window !== 'undefined' ? window.localStorage.getItem(storageKey) : null
      return saved === 'direct' ? 'direct' : 'simplified'
    } catch { return 'simplified' }
  })
  function choose(m: SettleMode) {
    setMode(m)
    try { window.localStorage.setItem(storageKey, m) } catch { /* private mode: just don't remember */ }
  }

  const name = (key: string) =>
    key === me.person_key ? 'You' : group.members.find((m) => m.person_key === key)?.name ?? key
  const transfers = transfersFor(events, mode, me.person_key)
  const note = MODES.find((m) => m.key === mode)!.note

  return (
    <>
      <button onClick={onBack} style={backBtn}>‹ Back</button>
      <h2 style={{ fontSize: 20, fontWeight: 800, margin: '4px 0 12px' }}>Settle up</h2>

      <div role="radiogroup" aria-label="Settle method" style={segment}>
        {MODES.map((m) => (
          <button key={m.key} role="radio" aria-checked={mode === m.key} onClick={() => choose(m.key)}
            style={{ ...segmentBtn, ...(mode === m.key ? segmentOn : null) }}>
            {m.label}
          </button>
        ))}
      </div>
      <p style={{ color: '#8E8E97', fontSize: 12, margin: '8px 2px 14px' }}>{note}</p>

      {transfers.length === 0 ? (
        <div style={{ ...card, display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ color: '#12CF7A' }}>✓</span>
          <span style={{ fontSize: 14 }}>Nothing to settle between you and anyone.</span>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {transfers.map((t) => {
            const key = `${t.from}>${t.to}`
            const youPay = t.from === me.person_key
            const other = youPay ? t.to : t.from
            const otherMember = group.members.find((m) => m.person_key === other)
            return (
              <div key={`${mode}|${key}|${t.sen}`} style={{ ...card, display: 'flex', alignItems: 'center', gap: 11 }}>
                <Avatar name={otherMember?.name ?? other} idx={otherMember?.color_index ?? 0} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>
                    {youPay ? `You pay ${name(other)}` : `${name(other)} pays you`}
                  </div>
                  <div style={{ fontWeight: 800, fontSize: 13, color: youPay ? '#FFA114' : '#12CF7A' }}>
                    {fmt(t.sen)}
                  </div>
                </div>
                <button onClick={() => onMarkPaid(t)} disabled={settling === key} style={settleBtn}>
                  {settling === key ? '…' : 'Mark paid'}
                </button>
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}

// ---- presentational bits ----

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main style={{ minHeight: '100dvh', background: '#0A0A0C', color: '#F5F5F7',
      fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
      padding: '32px 18px', display: 'flex', justifyContent: 'center' }}>
      <div style={{ width: '100%', maxWidth: 420 }}>{children}</div>
    </main>
  )
}

function Avatar({ name, idx }: { name: string; idx: number }) {
  return (
    <div style={{ width: 34, height: 34, borderRadius: '50%',
      background: AVATAR[idx % AVATAR.length], color: '#0A0A0C',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontWeight: 800, fontSize: 14, flexShrink: 0 }}>
      {(name[0] ?? '?').toUpperCase()}
    </div>
  )
}

const brand: React.CSSProperties = { fontSize: 26, fontWeight: 800, letterSpacing: -1 }
const card: React.CSSProperties = { background: '#141419', borderRadius: 15, padding: 14 }
const memberRow: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 11,
  background: '#141419', border: 'none', borderRadius: 13, padding: 14, color: '#F5F5F7', width: '100%' }
const errorBox: React.CSSProperties = { background: 'rgba(255,68,56,.1)', border: '1px solid rgba(255,68,56,.3)',
  color: '#FF4438', borderRadius: 11, padding: '10px 12px', fontSize: 13, marginBottom: 12 }
const settleBtn: React.CSSProperties = { minHeight: 36, background: '#12CF7A', color: '#04231A',
  border: 'none', borderRadius: 9, padding: '5px 12px', fontSize: 11.5, fontWeight: 800, cursor: 'pointer' }
const settleUpBtn: React.CSSProperties = { marginTop: 12, width: '100%', minHeight: 44, background: '#12CF7A',
  color: '#04231A', border: 'none', borderRadius: 11, fontWeight: 800, fontSize: 14, cursor: 'pointer' }
const backBtn: React.CSSProperties = { background: 'none', border: 'none', color: '#12CF7A', fontWeight: 700,
  fontSize: 14, padding: '8px 0', minHeight: 44, cursor: 'pointer' }
const segment: React.CSSProperties = { display: 'flex', background: '#141419', borderRadius: 11, padding: 3, gap: 3 }
const segmentBtn: React.CSSProperties = { flex: 1, minHeight: 40, border: 'none', borderRadius: 9, background: 'transparent',
  color: '#B9B9C2', fontWeight: 700, fontSize: 13.5, cursor: 'pointer' }
const segmentOn: React.CSSProperties = { background: '#2A2A32', color: '#F5F5F7' }
const notListedBtn: React.CSSProperties = { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2,
  background: 'transparent', border: '1px dashed rgba(46,140,255,.5)', borderRadius: 13, padding: 14,
  color: '#F5F5F7', width: '100%', minHeight: 44, cursor: 'pointer', marginTop: 4 }
const nameInput: React.CSSProperties = { background: '#0A0A0C', border: '1px solid #2A2A32', borderRadius: 10,
  padding: '12px', color: '#F5F5F7', fontSize: 16, minHeight: 44 }
const joinBtn: React.CSSProperties = { flex: 1, background: '#12CF7A', color: '#04231A', border: 'none',
  borderRadius: 10, padding: '12px', fontWeight: 800, fontSize: 14, minHeight: 44, cursor: 'pointer' }
const cancelBtn: React.CSSProperties = { flex: 1, background: '#1C1C22', color: '#F5F5F7', border: 'none',
  borderRadius: 10, padding: '12px', fontWeight: 600, fontSize: 14, minHeight: 44, cursor: 'pointer' }
