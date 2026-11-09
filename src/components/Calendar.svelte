<script lang="ts">
  import { onMount } from 'svelte'
  import { CalendarAPI } from '../api'
  import { eventToICS, parseICSBlocks } from '../lib/vcf'
  import { loadSelection, saveSelection, STORAGE_KEY } from '../lib/calSelection'

  let { showToast } = $props()

  interface Cal { uri: string; name: string; color?: string }
  let calendars = $state<Cal[]>([])
  let selectedCals = $state<string[]>([])
  let events = $state<any[]>([])
  let viewDate = $state(new Date())
  let selectedUid = $state<string | null>(null)
  let loading = $state(false)
  let busy = $state(false)
  let err = $state('')
  let partialErrors = $state<string[]>([])
  let monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December']
  let weekdayNames = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun']

  // Editor form fields
  let showEditor = $state(false)
  let editingUid = $state<string | null>(null)
  let fSummary = $state('')
  let fStart = $state('') // yyyy-mm-dd
  let fTime = $state('')  // hh:mm
  let fEnd = $state('')
  let fEndTime = $state('')
  let fLocation = $state('')
  let fDescription = $state('')
  let fAllDay = $state(false)

  function fmtISODate(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
  function eventDateStr(ev: string | undefined): string {
    if (!ev) return ''
    let s = ev.replace('Z', '').replace(/(\d{4})(\d{2})(\d{2})/g, '$1-$2-$3')
    return s.slice(0, 10)
  }
  function monthStart(): Date { const d = new Date(viewDate); d.setDate(1); return d }
  function monthEnd(): Date { const d = new Date(viewDate); d.setMonth(d.getMonth() + 1); d.setDate(0); return d }
  function isoWeek(d: Date, extraDayOffset = 0): string {
    const x = new Date(d); x.setDate(d.getDate() + extraDayOffset)
    return fmtISODate(x)
  }

  let firstSel = $derived(
    calendars.find(c => selectedCals.includes(c.uri)) || null
  )

  async function loadCalendars() {
    try {
      const data = await CalendarAPI.calendars()
      calendars = data.calendars || []
      selectedCals = loadSelection(localStorage, STORAGE_KEY, calendars)
    } catch (e: any) { err = e.message }
  }

  function toggleCal(uri: string) {
    const next = selectedCals.includes(uri)
      ? selectedCals.filter(u => u !== uri)
      : [...selectedCals, uri]
    selectedCals = next
    saveSelection(localStorage, STORAGE_KEY, calendars, next)
    loadEvents()
  }
  function selectAll() {
    selectedCals = calendars.map(c => c.uri)
    saveSelection(localStorage, STORAGE_KEY, calendars, selectedCals)
    loadEvents()
  }
  function selectNone() {
    selectedCals = []
    saveSelection(localStorage, STORAGE_KEY, calendars, selectedCals)
    loadEvents()
  }

  async function loadEvents() {
    if (!selectedCals.length) { events = []; partialErrors = []; return }
    const s = isoWeek(monthStart(), -2)
    const e = isoWeek(monthEnd(), 2)
    try {
      loading = true
      partialErrors = []
      const results = await Promise.allSettled(
        selectedCals.map(uri => CalendarAPI.events(uri, s, e))
      )
      const byUid = new Map<string, any>()
      for (const r of results) {
        if (r.status === 'rejected') { partialErrors.push(String((r.reason && r.reason.message) || r.reason)); continue }
        for (const ev of (r.value.events || [])) {
          if (!byUid.has(ev.uid)) byUid.set(ev.uid, ev)
        }
      }
      events = Array.from(byUid.values())
    } catch (e2: any) {
      err = e2.message
    } finally { loading = false }
  }

  function eventsForDay(dateStr: string): any[] {
    return events.filter(ev => {
      const d = eventDateStr(ev.start).replace(/[-:]/g, '').slice(0, 8)
      return d === dateStr.replace(/[-]/g, '')
    })
  }

  function shiftMonth(delta: number) {
    viewDate = new Date(viewDate.getFullYear(), viewDate.getMonth() + delta, 1)
    loadEvents()
  }
  function goToday() {
    viewDate = new Date()
    loadEvents()
  }

  function openCreate(dateStr?: string) {
    editingUid = null
    fSummary = ''
    fStart = dateStr || fmtISODate(viewDate)
    fEnd = fStart
    fTime = '09:00'
    fEndTime = '10:00'
    fLocation = ''
    fDescription = ''
    fAllDay = false
    showEditor = true
  }

  function openEdit(ev: any) {
    editingUid = ev.uid
    fSummary = ev.summary || ''
    fStart = eventDateStr(ev.start)
    fEnd = eventDateStr(ev.end) || fStart
    const raw0 = String(ev.start || '')
    fAllDay = !!(ev.allDay ?? (raw0.replace(/[-T:Z]/g, '').length <= 8))
    fTime = raw0.slice(8, 12).length === 4 ? raw0.slice(8, 10) + ':' + raw0.slice(10, 12) : ''
    fEndTime = fTime || ''
    fLocation = ev.location || ''
    fDescription = ev.description || ''
    showEditor = true
  }

  function combinedStart(): string {
    if (fAllDay) return fStart.replace(/-/g, '')
    return fStart.replace(/-/g, '') + 'T' + (fTime || '0900').replace(':', '') + '00'
  }
  function combinedEnd(): string {
    if (!fEnd) return ''
    if (fAllDay) return fEnd.replace(/-/g, '')
    const t = (fEndTime || fTime || '1000').replace(':', '')
    return fEnd.replace(/-/g, '') + 'T' + (t.length >= 4 ? t.slice(0, 4) : '1000') + '00'
  }

  async function saveEvent() {
    if (!firstSel) return
    if (!fSummary.trim() && !fDescription.trim()) { showToast('Add a title or description'); return }
    try {
      busy = true
      const uid = editingUid || ('leoposta_' + Date.now())
      const ev = {
        summary: fSummary,
        start: combinedStart(),
        end: combinedEnd() || undefined,
        location: fLocation,
        description: fDescription,
        allDay: fAllDay,
      }
      const ics = eventToICS(ev, uid)
      await CalendarAPI.saveEvent(firstSel.uri, ics, editingUid || undefined)
      showEditor = false
      await loadEvents()
      showToast(editingUid ? 'Event updated' : 'Event created')
    } catch (e: any) { showToast(e.message, 5000) } finally { busy = false }
  }

  async function deleteEvent(uid: string) {
    if (!firstSel) return
    if (!confirm('Delete this event?')) return
    try {
      busy = true
      await CalendarAPI.deleteEvent(firstSel.uri, uid)
      selectedUid = null
      await loadEvents()
      showToast('Event deleted')
    } catch (e: any) { showToast(e.message, 5000) } finally { busy = false }
  }

  function handleImportIcs(file: File) {
    const reader = new FileReader()
    reader.onload = async () => {
      const ics = String(reader.result || '')
      const blocks = parseICSBlocks(ics)
      if (!firstSel) return
      try {
        busy = true
        await CalendarAPI.importICS(firstSel.uri, ics)
        await loadEvents()
        showToast(`Imported ${Math.max(blocks.length, 1)} event(s)`);
      } catch (e: any) { showToast(e.message, 5000) } finally { busy = false }
    }
    reader.readAsText(file)
  }

  function importIcsInput(e: Event) {
    const input = e.target as HTMLInputElement
    const file = input.files?.[0]
    if (file) handleImportIcs(file)
    input.value = ''
  }

  // Build a 6x7 month grid (called as grid() in the template)
  function grid() {
    const first = new Date(viewDate.getFullYear(), viewDate.getMonth(), 1)
    // Monday-first offset: JS getDay() 0=Sun..6=Sat -> Mon=0
    const offset = (first.getDay() + 6) % 7
    const startDay = (1 - offset)
    const start = new Date(viewDate.getFullYear(), viewDate.getMonth(), startDay)
    const cells: { dateStr: string; inMonth: boolean; date: Date }[] = []
    for (let i = 0; i < 42; i++) {
      const d = new Date(start); d.setDate(start.getDate() + i)
      cells.push({ dateStr: fmtISODate(d), inMonth: d.getMonth() === viewDate.getMonth(), date: d })
    }
    return cells
  }

  onMount(() => { loadCalendars().then(() => loadEvents()) })
</script>

<section class="calendar">
  <aside class="cal-side">
    <div class="cal-side-head">
      <h2>Calendars</h2>
      <button class="add-evt" onclick={() => openCreate()}>+ New event</button>
    </div>
    <div class="cal-actions">
      <button class="cal-act" onclick={selectAll} disabled={!calendars.length}>All</button>
      <button class="cal-act" onclick={selectNone} disabled={!selectedCals.length}>None</button>
    </div>
    <div class="cal-list">
      {#each calendars as cal (cal.uri)}
        <label class="cal-item" class:checked={selectedCals.includes(cal.uri)}>
          <input
            type="checkbox"
            checked={selectedCals.includes(cal.uri)}
            onchange={() => toggleCal(cal.uri)}
            aria-label={cal.name}
          />
          <span class="cal-dot" style="background:{cal.color || 'var(--color-accent)'}"></span>
          <span class="cal-name">{cal.name}</span>
        </label>
      {/each}
      {#if calendars.length === 0}<p class="empty">No calendars found.</p>{/if}
    </div>
    <div class="cal-import">
      <label class="import-btn">
        Import .ics
        <input type="file" accept=".ics,text/calendar" onchange={importIcsInput} disabled={busy} />
      </label>
    </div>
  </aside>

  <div class="cal-main">
    <header class="cal-top">
      <div class="cal-nav">
        <button aria-label="Previous month" onclick={() => shiftMonth(-1)}>‹</button>
        <button onclick={goToday}>Today</button>
        <button aria-label="Next month" onclick={() => shiftMonth(1)}>›</button>
        <h3>{monthNames[viewDate.getMonth()]} {viewDate.getFullYear()}</h3>
      </div>
    </header>

    {#if err}
      <div class="cal-err">
        <span>{err}</span>
        <button onclick={loadEvents}>Retry</button>
      </div>
    {/if}
    {#if !err && partialErrors.length}
      <div class="cal-warn">Could not load {partialErrors.length} calendar(s): {partialErrors[0]}</div>
    {/if}

    <div class="weekdays">
      {#each weekdayNames as wd, i}<div class="wd">{wd}</div>{/each}
    </div>

    <div class="grid" role="grid">
      {#each grid() as cell, i (cell.dateStr)}
        {@const dayEvents = eventsForDay(cell.dateStr)}
        <div
          class="cell"
          class:out={cell.inMonth === false}
          class:today={cell.dateStr === fmtISODate(new Date())}
          onclick={() => openCreate(cell.dateStr)}
        >
          <div class="cell-head">
            <span class="daynum">{cell.date.getDate()}</span>
          </div>
          {#if dayEvents.length > 0}
            <div class="chips">
              {#each dayEvents.slice(0, 3) as ev (ev.uid)}
                <button
                  class="chip"
                  class:sel={selectedUid === ev.uid}
                  onclick={(e) => { e.stopPropagation(); selectedUid = ev.uid; if (!showEditor) openEdit(ev) }}
                  oncontextmenu={(e) => { e.preventDefault(); e.stopPropagation(); deleteEvent(ev.uid) }}
                >
                  {ev.summary || '(untitled)'}
                </button>
              {/each}
              {#if dayEvents.length > 3}<span class="more">+{dayEvents.length - 3} more</span>{/if}
            </div>
          {/if}
        </div>
      {/each}
    </div>
  </div>

  {#if showEditor}
    <div class="modal-back" onclick={(e) => { if (e.target === e.currentTarget) showEditor = false }} role="dialog">
      <div class="modal">
        <h4>{editingUid ? 'Edit event' : 'New event'}</h4>
        {#if firstSel}<p class="cal-target">Target calendar: {firstSel.name}</p>{/if}
        <label>
          <span>Title</span>
          <input type="text" bind:value={fSummary} placeholder="Event title" />
        </label>
        <label class="chk">
          <input type="checkbox" bind:checked={fAllDay} /> <span>All-day</span>
        </label>
        <div class="row">
          <label><span>Start</span><input type="date" bind:value={fStart} /></label>
          {#if !fAllDay}<label><span>Time</span><input type="time" bind:value={fTime} /></label>{/if}
        </div>
        <div class="row">
          <label><span>End</span><input type="date" bind:value={fEnd} /></label>
          {#if !fAllDay}<label><span>Time</span><input type="time" bind:value={fEndTime} placeholder={fTime || '10:00'} /></label>{/if}
        </div>
        <label><span>Location</span><input type="text" bind:value={fLocation} /></label>
        <label><span>Description</span><textarea bind:value={fDescription} rows="3"></textarea></label>
        <div class="actions">
          {#if editingUid}<button class="danger" onclick={() => { showEditor = false; deleteEvent(editingUid!) }}>Delete</button>{/if}
          <span class="spacer"></span>
          <button class="ghost" onclick={() => showEditor = false}>Cancel</button>
          <button class="primary" onclick={saveEvent} disabled={busy}>{editingUid ? 'Save changes' : 'Create'}</button>
        </div>
      </div>
    </div>
  {/if}
</section>

<style>
  .calendar { display: flex; flex: 1; overflow: hidden; height: 100%; }
  .cal-side { width: 220px; background: var(--color-sidebar); border-right: 1px solid var(--color-border); display: flex; flex-direction: column; }
  .cal-side-head { padding: 12px 12px 8px; display: flex; flex-direction: column; gap: 8px; }
  .cal-side-head h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.6px; color: var(--color-text-secondary); margin: 0 0 4px; font-weight: 700; }
  .add-evt { background: var(--color-accent); color: #fff; border: none; padding: 7px 12px; border-radius: var(--radius-sm); font-weight: 600; font-size: 12px; cursor: pointer; }
  .add-evt:hover { background: var(--color-accent-hover); }
  .cal-actions { display: flex; gap: 6px; padding: 4px 8px; }
  .cal-act { flex: 1; padding: 5px 8px; border: 1px solid var(--color-border); background: var(--color-bg-secondary); color: var(--color-text); border-radius: 6px; font-size: 11px; font-weight: 600; cursor: pointer; }
  .cal-act:hover:not(:disabled) { border-color: var(--color-accent); color: var(--color-accent); }
  .cal-act:disabled { opacity: 0.4; cursor: default; }
  .cal-list { flex: 1; overflow-y: auto; padding: 4px 8px; }
  .cal-item { display: flex; align-items: center; gap: 8px; width: 100%; padding: 7px 8px; border: none; background: transparent; color: var(--color-text); border-radius: 6px; font-size: 13px; cursor: pointer; text-align: left; margin-bottom: 2px; }
  .cal-item input[type="checkbox"] { width: 14px; height: 14px; flex: 0 0 auto; margin: 0; accent-color: var(--color-accent); }
  .cal-item.checked { font-weight: 500; }
  .cal-warn { background: var(--color-bg-secondary); color: var(--color-text-secondary); border-left: 3px solid var(--color-warn, #b58900); padding: 8px 18px; font-size: 12px; }
  .cal-target { font-size: 11px; color: var(--color-text-secondary); margin: -6px 0 10px; }
  .cal-item:hover { background: var(--color-hover); }
  .cal-dot { width: 10px; height: 10px; border-radius: 3px; flex: 0 0 auto; }
  .cal-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .empty { font-size: 12px; color: var(--color-text-secondary); padding: 8px; }
  .cal-import { padding: 10px; border-top: 1px solid var(--color-border); }
  .import-btn { display: flex; align-items: center; gap: 8px; padding: 7px 10px; border: 1px dashed var(--color-border); border-radius: 6px; font-size: 12px; color: var(--color-text-secondary); cursor: pointer; font-weight: 500; }
  .import-btn:hover { border-color: var(--color-accent); color: var(--color-accent); }
  .import-btn input { display: none; }

  .cal-main { flex: 1; overflow: hidden; display: flex; flex-direction: column; background: var(--color-bg); }
  .cal-top { display: flex; align-items: center; padding: 10px 18px; border-bottom: 1px solid var(--color-border); }
  .cal-nav { display: flex; align-items: center; gap: 6px; }
  .cal-nav button { background: var(--color-bg-secondary); border: 1px solid var(--color-border); color: var(--color-text); width: 28px; height: 28px; border-radius: 6px; cursor: pointer; font-size: 14px; }
  .cal-nav buttonhover { background: var(--color-hover); }
  .cal-nav button:nth-child(2) { width: auto; padding: 0 12px; font-size: 12px; font-weight: 500; }
  .cal-nav h3 { font-size: 15px; font-weight: 600; margin-left: 10px; }
  .cal-err { background: var(--danger-bg); color: var(--color-danger); padding: 10px 18px; font-size: 13px; display: flex; gap: 12px; align-items: center; justify-content: space-between; }
  .cal-err button { background: var(--color-danger); color: #fff; border: none; padding: 5px 10px; border-radius: 4px; font-size: 12px; }
  .weekdays { display: grid; grid-template-columns: repeat(7, 1fr); padding: 6px 12px 4px; border-bottom: 1px solid var(--color-border); }
  .wd { font-size: 11px; font-weight: 600; color: var(--color-text-secondary); text-transform: uppercase; letter-spacing: 0.4px; }
  .grid { flex: 1; overflow-y: auto; padding: 10px 12px 12px; display: grid; grid-template-columns: repeat(7, 1fr); grid-auto-rows: minmax(82px, 1fr); gap: 6px; }
  .cell { border: 1px solid var(--color-border); border-radius: 6px; padding: 6px 7px; cursor: pointer; transition: border-color .1s, background .1s; overflow: hidden; background: var(--color-bg); }
  .cell:hover { border-color: var(--color-accent); background: var(--color-hover); }
  .cell.out { opacity: 0.55; background: transparent; }
  .cell.today { border-color: var(--color-accent); background: var(--color-selected); }
  .cell-head { display: flex; justify-content: flex-end; }
  .daynum { font-size: 11px; font-weight: 600; color: var(--color-text-secondary); padding: 2px 6px; border-radius: 5px; }
  .cell.today .daynum { background: var(--color-accent); color: #fff; }
  .chips { display: flex; flex-direction: column; gap: 2px; margin-top: 4px; }
  .chip { text-align: left; font-size: 11px; border: none; background: var(--color-selected); color: var(--color-text); padding: 3px 5px; border-radius: 4px; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chip:hover { background: var(--color-accent); color: #fff; }
  .chip.sel { outline: 2px solid var(--color-accent); }
  .more { font-size: 10px; color: var(--color-text-secondary); }

  .modal-back { position: fixed; inset: 0; background: rgba(0,0,0,0.4); z-index: 150; display: flex; align-items: center; justify-content: center; padding: 20px; }
  .modal { background: var(--color-bg); border-radius: 14px; padding: 18px 20px 14px; width: min(560px, 92vw); max-height: 90vh; overflow-y: auto; box-shadow: 0 18px 60px rgba(0,0,0,0.35); border: 1px solid var(--color-border); }
  .modal h4 { font-size: 15px; font-weight: 700; margin: 0 0 12px; }
  .modal label { display: block; margin-bottom: 10px; font-size: 12px; color: var(--color-text-secondary); font-weight: 600; }
  .modal label.chk { display: flex; align-items: center; gap: 8px; }
  .modal label.chk span { font-size: 13px; color: var(--color-text); }
  .modal input, .modal textarea { display: block; width: 100%; margin-top: 4px; padding: 8px 10px; border: 1px solid var(--color-border); border-radius: 6px; font-size: 13px; background: var(--color-bg); color: var(--color-text); }
  .modal input:focus, .modal textarea:focus { outline: none; border-color: var(--color-accent); }
  .modal .row { display: flex; gap: 10px; }
  .modal .row > label { flex: 1; }
  .actions { display: flex; gap: 8px; margin-top: 6px; }
  .actions .spacer { flex: 1; }
  .actions button { padding: 8px 14px; border-radius: 6px; font-size: 13px; font-weight: 500; cursor: pointer; border: 1px solid var(--color-border); background: var(--color-bg-secondary); color: var(--color-text); }
  .actions .primary { background: var(--color-accent); color: #fff; border-color: var(--color-accent); }
  .actions .primary:hover { background: var(--color-accent-hover); }
  .actions .danger { background: transparent; color: var(--color-danger); border-color: var(--color-danger); }
  .actions .ghost { background: transparent; }
</style>
