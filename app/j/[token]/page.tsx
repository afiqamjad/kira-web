'use client'

import { useEffect, useState, useCallback } from 'react'
import { useParams } from 'next/navigation'
import { supabase, ensureAnonSession } from '../../../lib/supabase'
import {
  balanceFor, activityFor, paidBy, shareOf, owesOn, settledExpenseIds, fmt,
  type EventRow, type Expense,
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

  // Settle one activity: record that `me` paid their share to the expense's payer.
  async function settleExpense(e: Expense) {
    if (!group || !me) return
    const payer = e.payers[0]?.person
    if (!payer) return
    setSettling(e.id); setError(null)
    const { error } = await supabase.from('events').insert({
      group_id: group.id,
      kind: 'settled',
      payload: { from: me.person_key, to: payer, sen: shareOf(e, me.person_key), expenseId: e.id },
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
        <MemberPanel
          group={group} me={me} events={events}
          onDisconnect={disconnect} busy={busy}
          onSettle={settleExpense} settling={settling}
        />
      )}
    </Shell>
  )
}

function MemberPanel({ group, me, events, onDisconnect, busy, onSettle, settling }:
  { group: GroupInfo; me: Member; events: EventRow[]; onDisconnect: () => void; busy: boolean;
    onSettle: (e: Expense) => void; settling: string | null }) {
  const bal = balanceFor(events, me.person_key)
  const activity = activityFor(events, me.person_key)
  const settled = settledExpenseIds(events, me.person_key)

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
      </div>

      <div style={{ color: '#8E8E97', fontSize: 11, fontWeight: 800, letterSpacing: 0.5, marginBottom: 8 }}>
        YOUR ACTIVITY
      </div>
      {activity.length === 0 ? (
        <p style={{ color: '#8E8E97', fontSize: 14 }}>You&rsquo;re not part of any expense here yet.</p>
      ) : (
        <div style={card}>
          {activity.map((e, i) => {
            const share = shareOf(e, me.person_key)
            const iOwe = owesOn(e, me.person_key)
            const isSettled = settled.has(e.id)
            return (
              <div key={e.id} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '11px 0',
                borderBottom: i < activity.length - 1 ? '1px solid #1C1C22' : 'none' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600 }}>{e.merchant}</div>
                  <div style={{ color: '#8E8E97', fontSize: 11 }}>
                    {new Date(e.occurredAt).toLocaleString('en-MY', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}
                    {' · '}{paidBy(e, me.person_key) ? 'you paid' : 'your share'}
                  </div>
                </div>

                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 13,
                    color: isSettled ? '#8E8E97' : '#F5F5F7',
                    textDecoration: isSettled ? 'line-through' : 'none' }}>
                    {fmt(share || 0)}
                  </div>

                  {/* Only expenses you owe on get a settle control. */}
                  {iOwe && (
                    isSettled ? (
                      <span style={settledPill}>✓ Settled</span>
                    ) : (
                      <button onClick={() => onSettle(e)} disabled={settling === e.id} style={settleBtn}>
                        {settling === e.id ? '…' : 'Settle up'}
                      </button>
                    )
                  )}
                </div>
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
const settleBtn: React.CSSProperties = { marginTop: 5, background: '#12CF7A', color: '#04231A',
  border: 'none', borderRadius: 9, padding: '5px 12px', fontSize: 11.5, fontWeight: 800, cursor: 'pointer' }
const settledPill: React.CSSProperties = { display: 'inline-block', marginTop: 5,
  background: 'rgba(18,207,122,.16)', color: '#12CF7A', borderRadius: 9,
  padding: '4px 10px', fontSize: 11, fontWeight: 800 }
const notListedBtn: React.CSSProperties = { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2,
  background: 'transparent', border: '1px dashed rgba(46,140,255,.5)', borderRadius: 13, padding: 14,
  color: '#F5F5F7', width: '100%', minHeight: 44, cursor: 'pointer', marginTop: 4 }
const nameInput: React.CSSProperties = { background: '#0A0A0C', border: '1px solid #2A2A32', borderRadius: 10,
  padding: '12px', color: '#F5F5F7', fontSize: 16, minHeight: 44 }
const joinBtn: React.CSSProperties = { flex: 1, background: '#12CF7A', color: '#04231A', border: 'none',
  borderRadius: 10, padding: '12px', fontWeight: 800, fontSize: 14, minHeight: 44, cursor: 'pointer' }
const cancelBtn: React.CSSProperties = { flex: 1, background: '#1C1C22', color: '#F5F5F7', border: 'none',
  borderRadius: 10, padding: '12px', fontWeight: 600, fontSize: 14, minHeight: 44, cursor: 'pointer' }
