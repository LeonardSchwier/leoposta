<script lang="ts">
  import { onMount } from 'svelte'
  import { CalendarAPI } from '../api'
  import { eventToICS } from '../lib/vcf'
  import { patchEventICS } from '../lib/icsPatch'
  import { loadSelection, saveSelection, STORAGE_KEY } from '../lib/calSelection'
  import {
    fmtISODate, eventOnDay, timeLabel, icsToLocalParts, localToIcsUtc, dateToIcsDate,
    weekDays, monthGrid, isAllDay, eventRange
  } from '../lib/calendarView'
  import RecipientAutocomplete from './RecipientAutocomplete.svelte'

  let { showToast } = $props()

  interface Cal { uri: string; name: string; color?: string }
  interface Ev {
    uid: string; summary: string; start: string; end?: string; allDay?: boolean
    location?: string; description?: string; attendees?: string[]
    calendar: string; href?: string; recurring?: boolean; rrule?: string; recurrenceId?: string
    ics?: string
  }
  let calendars = $state<Cal[]>([])
  let configured = $state(true)
  let selectedCals = $state<string[]>([])
  let events = $state<Ev[]>([])
  let viewDate = $state(new Date())
  let viewMode = $state<'month' | 'week'>('month')
  let selectedKey = $state<string | null>(null)
  let loading = $state(false)
  let busy = $state(false)
  let err = $state('')
  let partialErrors = $state<string[]>([])
  const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December']
  const weekdayNames = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun']

  // Editor form fields
  let showEditor = $state(false)
  let editing = $state<Ev | null>(null)
  let fSummary = $state('')
  let fStart = $state('') // yyyy-mm-dd
  let fTime = $state('')  // hh:mm
  let fEnd = $state('')
  let fEndTime = $state('')
  let fLocation = $state('')
  let fDescription = $state('')
  let fAllDay = $state(false)
  let fAttendees = $state('') // comma/space separated emails
  let fTargetCal = $state<string>('')

  const evKey = (ev: Ev) => `${ev.calendar}|${ev.uid}|${ev.recurrenceId || ev.start}`

  let firstSel = $derived(calendars.find(c => selectedCals.includes(c.uri)) || null)

  function visibleRange(): { start: Date, end: Date } {
    if (viewMode === 'week') {
      const days = weekDays(viewDate)
      return { start: days[0], end: days[6] }
    }
    const cells = monthGrid(viewDate)
    return { start: cells[0].date, end: cells[cells.length - 1].date }
  }

  async function loadCalendars() {
    err = ''
    try {
      const data = await CalendarAPI.calendars()
      configured = data.configured
      calendars = data.calendars || []
      selectedCals = loadSelection(localStorage, STORAGE_KEY, calendars)
    } catch (e: any) { err = e.message; calendars = []; selectedCals = [] }
  }

  async function reload() {
    await loadCalendars()
    if (!err) await loadEvents()
  }

  function toggleCal(uri: string) {
    const next = selectedCals.includes(uri) ? selectedCals.filter(u => u !== uri) : [...selectedCals, uri]
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

  // Responses for an older view (fast navigation) must not overwrite a newer one.
  let loadSeq = 0
  async function loadEvents() {
    const seq = ++loadSeq
    if (!selectedCals.length) { events = []; partialErrors = []; return }
    const r = visibleRange()
    // One day of margin each side: a UTC instant can fall on the neighbouring local day.
    const s = fmtISODate(new Date(r.start.getFullYear(), r.start.getMonth(), r.start.getDate() - 1))
    const e = fmtISODate(new Date(r.end.getFullYear(), r.end.getMonth(), r.end.getDate() + 1))
    loading = true
    try {
      const results = await Promise.allSettled(selectedCals.map(uri => CalendarAPI.events(uri, s, e)))
      if (seq !== loadSeq) return
      const errors: string[] = []
      const byKey = new Map<string, Ev>()
      results.forEach((res, i) => {
        if (res.status === 'rejected') { errors.push(String((res.reason && res.reason.message) || res.reason)); return }
        for (const ev of (res.value.events || [])) {
          const full: Ev = { ...ev, calendar: ev.calendar || selectedCals[i] }
          if (!byKey.has(evKey(full))) byKey.set(evKey(full), full)
        }
      })
      partialErrors = errors
      events = Array.from(byKey.values())
      if (errors.length && errors.length === results.length) err = errors[0]
      else err = ''
    } finally { if (seq === loadSeq) loading = false }
  }

  function eventsForDay(dateStr: string): Ev[] {
    return events
      .filter(ev => eventOnDay(ev, dateStr))
      .sort((a, b) => (isAllDay(a) === isAllDay(b) ? (eventRange(a)?.start.getTime() ?? 0) - (eventRange(b)?.start.getTime() ?? 0) : isAllDay(a) ? -1 : 1))
  }

  function shift(delta: number) {
    viewDate = viewMode === 'week'
      ? new Date(viewDate.getFullYear(), viewDate.getMonth(), viewDate.getDate() + 7 * delta)
      : new Date(viewDate.getFullYear(), viewDate.getMonth() + delta, 1)
    loadEvents()
  }
  function goToday() { viewDate = new Date(); loadEvents() }
  function setMode(m: 'month' | 'week') { if (viewMode !== m) { viewMode = m; loadEvents() } }

  function title(): string {
    if (viewMode === 'month') return `${monthNames[viewDate.getMonth()]} ${viewDate.getFullYear()}`
    const d = weekDays(viewDate)
    const f = (x: Date) => `${x.getDate()} ${monthNames[x.getMonth()].slice(0, 3)}`
    return `${f(d[0])} – ${f(d[6])} ${d[6].getFullYear()}`
  }

  function openCreate(dateStr?: string) {
    editing = null
    fSummary = ''
    fStart = dateStr || fmtISODate(viewDate)
    fEnd = fStart
    fTime = '09:00'
    fEndTime = '10:00'
    fLocation = ''
    fDescription = ''
    fAllDay = false
    fAttendees = ''
    fTargetCal = firstSel?.uri || (calendars[0] && calendars[0].uri) || ''
    showEditor = true
  }

  function openEdit(ev: Ev) {
    editing = ev
    fSummary = ev.summary || ''
    fAllDay = isAllDay(ev)
    const s = icsToLocalParts(ev.start)
    fStart = s.date
    fTime = s.time
    if (fAllDay) {
      // DTEND of an all-day event is exclusive; the editor shows the last day.
      const r = eventRange(ev)
      fEnd = r ? fmtISODate(new Date(r.end.getFullYear(), r.end.getMonth(), r.end.getDate() - 1)) : fStart
      if (fEnd < fStart) fEnd = fStart
      fEndTime = ''
    } else {
      const e = icsToLocalParts(ev.end || ev.start)
      fEnd = e.date || fStart
      fEndTime = e.time || fTime
    }
    fLocation = ev.location || ''
    fDescription = ev.description || ''
    fAttendees = ev.attendees?.join(', ') || ''
    fTargetCal = ev.calendar
    showEditor = true
  }

  function editorTimes(): { start: string, end: string } | string {
    if (!fStart) return 'Pick a start date'
    if (fAllDay) {
      const endDate = fEnd && fEnd >= fStart ? fEnd : fStart
      return { start: dateToIcsDate(fStart), end: dateToIcsDate(endDate, 1) }
    }
    const start = localToIcsUtc(fStart, fTime || '09:00')
    const end = localToIcsUtc(fEnd || fStart, fEndTime || fTime || '10:00')
    if (end < start) return 'The event ends before it starts'
    return { start, end }
  }

  async function saveEvent() {
    const targetUri = fTargetCal || firstSel?.uri || calendars[0]?.uri
    if (!targetUri) { showToast('No calendar to save to'); return }
    if (!fSummary.trim() && !fDescription.trim()) { showToast('Add a title or description'); return }
    const times = editorTimes()
    if (typeof times === 'string') { showToast(times); return }
    const orig = editing
    try {
      busy = true
      const uid = orig?.uid || ('leoposta-' + crypto.randomUUID())
      const attendees = fAttendees.split(/[,\s;]+/).map(s => s.trim()).filter(s => s && s.includes('@'))
      // An existing event is patched in its own object (keeps TZID, RRULE,
      // EXDATE, overrides, alarms; one occurrence moved shifts the series);
      // a new one is built from the form.
      const patched = orig?.ics ? patchEventICS(orig.ics, orig.uid, {
        summary: fSummary, location: fLocation, description: fDescription, attendees, allDay: fAllDay,
        occurrenceStart: orig.start, start: times.start, end: times.end
      }) : null
      const ics = patched ?? eventToICS({
        summary: fSummary, start: times.start, end: times.end,
        location: fLocation, description: fDescription, allDay: fAllDay,
        attendees: attendees.length ? attendees : undefined,
        rrule: orig?.recurring ? orig.rrule : undefined
      }, uid)
      const moved = !!orig && orig.calendar !== targetUri
      await CalendarAPI.saveEvent(targetUri, ics, uid, orig && !moved ? orig.href : undefined)
      if (moved && orig) await CalendarAPI.deleteEvent(orig.calendar, orig.uid, orig.href)
      showEditor = false
      editing = null
      await loadEvents()
      showToast(orig ? 'Event updated' : 'Event created')
    } catch (e: any) { showToast(e.message, 5000) } finally { busy = false }
  }

  async function deleteEvent(ev: Ev) {
    if (!confirm(ev.recurring ? 'Delete this event and all its repetitions?' : 'Delete this event?')) return
    try {
      busy = true
      await CalendarAPI.deleteEvent(ev.calendar, ev.uid, ev.href)
      selectedKey = null
      showEditor = false
      editing = null
      await loadEvents()
      showToast('Event deleted')
    } catch (e: any) { showToast(e.message, 5000) } finally { busy = false }
  }

  function handleImportIcs(file: File) {
    const target = firstSel?.uri || calendars[0]?.uri
    if (!target) { showToast('No calendar to import into'); return }
    const reader = new FileReader()
    reader.onload = async () => {
      try {
        busy = true
        const r = await CalendarAPI.importICS(target, String(reader.result || ''))
        await loadEvents()
        const failed = r.failed?.length ? `, ${r.failed.length} rejected` : ''
        showToast(`Imported ${r.imported} of ${r.total} event(s)${failed}`, failed ? 6000 : 3000)
      } catch (e: any) { showToast(e.message, 5000) } finally { busy = false }
    }
    reader.onerror = () => showToast('Could not read the file', 5000)
    reader.readAsText(file)
  }

  function importIcsInput(e: Event) {
    const input = e.target as HTMLInputElement
    const file = input.files?.[0]
    if (file) handleImportIcs(file)
    input.value = ''
  }

  function cells() {
    if (viewMode === 'week') {
      return weekDays(viewDate).map(d => ({ dateStr: fmtISODate(d), inMonth: true, date: d }))
    }
    return monthGrid(viewDate)
  }

  onMount(() => { reload() })
</script>

<!-- Escape closes the editor dialog (unless an inner control, e.g. the
     autocomplete list, already used that Escape). -->
<svelte:window onkeydown={(e) => { if (e.key === 'Escape' && showEditor && !e.defaultPrevented) { e.preventDefault(); showEditor = false } }} />

<section class="calendar">
  <aside class="cal-side">
    <div class="cal-side-head">
      <h2>Calendars</h2>
      <button class="add-evt" onclick={() => openCreate()} disabled={!calendars.length}>+ New event</button>
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
      {#if calendars.length === 0 && configured && !err}<p class="empty">No calendars found on the server.</p>{/if}
    </div>
    <div class="cal-import">
      <label class="import-btn">
        Import .ics
        <input type="file" accept=".ics,text/calendar" onchange={importIcsInput} disabled={busy || !calendars.length} />
      </label>
    </div>
  </aside>
  <div class="cal-main">
    {#if !configured}
      <div class="not-configured" data-testid="dav-not-configured">
        <h3>Calendar is not set up</h3>
        <p>This account has no CalDAV server. Add a CalDAV/CardDAV URL to the account in <b>Settings → Account</b> to see and edit your calendars here.</p>
      </div>
    {:else}
    <header class="cal-top">
      <div class="cal-nav">
        <button aria-label={viewMode === 'week' ? 'Previous week' : 'Previous month'} onclick={() => shift(-1)}>‹</button>
        <button onclick={goToday}>Today</button>
        <button aria-label={viewMode === 'week' ? 'Next week' : 'Next month'} onclick={() => shift(1)}>›</button>
        <h3 data-testid="cal-title">{title()}</h3>
      </div>
      <div class="cal-mode" role="group" aria-label="View">
        <button class:active={viewMode === 'month'} aria-pressed={viewMode === 'month'} onclick={() => setMode('month')}>Month</button>
        <button class:active={viewMode === 'week'} aria-pressed={viewMode === 'week'} onclick={() => setMode('week')}>Week</button>
      </div>
    </header>
    {#if err}
      <div class="cal-err" role="alert">
        <span>{err}</span>
        <button onclick={reload} disabled={loading}>Retry</button>
      </div>
    {/if}
    {#if !err && partialErrors.length}
      <div class="cal-warn">Could not load {partialErrors.length} calendar(s): {partialErrors[0]}</div>
    {/if}
    <div class="weekdays">
      {#each weekdayNames as wd, i}<div class="wd">{wd}</div>{/each}
    </div>
    <div class="grid" class:week={viewMode === 'week'}>
      {#each cells() as cell (cell.dateStr)}
        {@const dayEvents = eventsForDay(cell.dateStr)}
        {@const max = viewMode === 'week' ? 12 : 3}
        <!-- Clicking anywhere in a day is a mouse shortcut; the day number is the keyboard-reachable button. -->
        <div
          class="cell"
          role="presentation"
          class:out={cell.inMonth === false}
          class:today={cell.dateStr === fmtISODate(new Date())}
          data-date={cell.dateStr}
          onclick={() => { if (calendars.length) openCreate(cell.dateStr) }}
        >
          <div class="cell-head">
            <button type="button" class="daynum" aria-label={`New event on ${cell.dateStr}`}
              onclick={(e) => { e.stopPropagation(); if (calendars.length) openCreate(cell.dateStr) }}>{cell.date.getDate()}</button>
          </div>
          {#if dayEvents.length > 0}
            <div class="chips">
              {#each dayEvents.slice(0, max) as ev (evKey(ev))}
                <button
                  class="chip"
                  class:sel={selectedKey === evKey(ev)}
                  title={ev.summary}
                  onclick={(e) => { e.stopPropagation(); selectedKey = evKey(ev); if (!showEditor) openEdit(ev) }}
                  oncontextmenu={(e) => { e.preventDefault(); e.stopPropagation(); deleteEvent(ev) }}
                >
                  {#if timeLabel(ev)}<span class="chip-time">{timeLabel(ev)}</span>{/if}{ev.summary || '(untitled)'}{#if ev.recurring} ↻{/if}
                </button>
              {/each}
              {#if dayEvents.length > max}<span class="more">+{dayEvents.length - max} more</span>{/if}
            </div>
          {/if}
        </div>
      {/each}
    </div>
    {/if}
  </div>
  {#if showEditor}
    <!-- Backdrop click is a mouse shortcut; Escape closes for keyboard users (svelte:window above). -->
    <div class="modal-back" role="presentation" onclick={(e) => { if (e.target === e.currentTarget) showEditor = false }}>
      <div class="modal" role="dialog" aria-modal="true" aria-label={editing ? 'Edit event' : 'New event'} tabindex="-1">
        <h4>{editing ? 'Edit event' : 'New event'}</h4>
        {#if editing?.recurring}<p class="cal-target">This is a repeating event: changes apply to every repetition.</p>{/if}
        {#if calendars.length}
          <label>
            <span>Target calendar</span>
            <select bind:value={fTargetCal}>
              {#each calendars as c (c.uri)}
                <option value={c.uri}>{c.name}</option>
              {/each}
            </select>
          </label>
        {/if}
        <label>
          <span>Title</span>
          <input type="text" bind:value={fSummary} placeholder="Event title" />
        </label>
        <label class="chk">
          <input type="checkbox" bind:checked={fAllDay} /> <span>All-day</span>
        </label>
        <div class="row">
          <label><span>Start</span><input type="date" bind:value={fStart} /></label>
          {#if !fAllDay}<label><span>Time</span><input type="time" bind:value={fTime} aria-label="Start time" /></label>{/if}
        </div>
        <div class="row">
          <label><span>End</span><input type="date" bind:value={fEnd} /></label>
          {#if !fAllDay}<label><span>Time</span><input type="time" bind:value={fEndTime} aria-label="End time" placeholder={fTime || '10:00'} /></label>{/if}
        </div>
        <label><span>Location</span><input type="text" bind:value={fLocation} /></label>
        <label>
          <span>Attendees</span>
          <RecipientAutocomplete bind:value={fAttendees} placeholder="alice@example.com, bob@example.com" />
        </label>
        <label><span>Description</span><textarea bind:value={fDescription} rows="3"></textarea></label>
        <div class="actions">
          {#if editing}<button class="danger" onclick={() => { if (editing) deleteEvent(editing) }}>Delete</button>{/if}
          <span class="spacer"></span>
          <button class="ghost" onclick={() => showEditor = false}>Cancel</button>
          <button class="primary" onclick={saveEvent} disabled={busy}>{editing ? 'Save changes' : 'Create'}</button>
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
  .add-evt { background: var(--color-accent); color: var(--color-on-accent); border: none; padding: 7px 12px; border-radius: var(--radius-sm); font-weight: 600; font-size: 12px; cursor: pointer; }
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
  .cal-nav button:hover { background: var(--color-hover); }
  .cal-nav button:nth-child(2) { width: auto; padding: 0 12px; font-size: 12px; font-weight: 500; }
  .cal-nav h3 { font-size: 15px; font-weight: 600; margin-left: 10px; }
  .cal-err { background: var(--danger-bg); color: var(--color-danger); padding: 10px 18px; font-size: 13px; display: flex; gap: 12px; align-items: center; justify-content: space-between; }
  .cal-err button { background: var(--color-danger); color: var(--color-on-danger); border: none; padding: 5px 10px; border-radius: 4px; font-size: 12px; }
  .weekdays { display: grid; grid-template-columns: repeat(7, 1fr); padding: 6px 12px 4px; border-bottom: 1px solid var(--color-border); }
  .wd { font-size: 11px; font-weight: 600; color: var(--color-text-secondary); text-transform: uppercase; letter-spacing: 0.4px; }
  .grid { flex: 1; overflow-y: auto; padding: 10px 12px 12px; display: grid; grid-template-columns: repeat(7, 1fr); grid-auto-rows: minmax(82px, 1fr); gap: 6px; }
  .cell { border: 1px solid var(--color-border); border-radius: 6px; padding: 6px 7px; cursor: pointer; transition: border-color .1s, background .1s; overflow: hidden; background: var(--color-bg); }
  .cell:hover { border-color: var(--color-accent); background: var(--color-hover); }
  /* Days of the neighbouring months: set apart by a lighter weight and no
     fill, not by fading the whole cell (that put the clickable day number
     at ~2.5:1). */
  .cell.out { background: transparent; }
  .cell.out .daynum { font-weight: 400; color: var(--color-text-muted); }
  .cell.today { border-color: var(--color-accent); background: var(--color-selected); }
  .cell-head { display: flex; justify-content: flex-end; }
  .daynum { font: inherit; font-size: 11px; font-weight: 600; color: var(--color-text-secondary); padding: 2px 6px; border-radius: 5px; border: none; background: transparent; cursor: pointer; }
  .cell.today .daynum { background: var(--color-accent); color: var(--color-on-accent); }
  .chips { display: flex; flex-direction: column; gap: 2px; margin-top: 4px; }
  .chip { text-align: left; font-size: 11px; border: none; background: var(--color-selected); color: var(--color-text); padding: 3px 5px; border-radius: 4px; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chip:hover { background: var(--color-accent); color: var(--color-on-accent); }
  .chip.sel { outline: 2px solid var(--color-accent); }
  .more { font-size: 10px; color: var(--color-text-secondary); }
  .chip-time { font-variant-numeric: tabular-nums; opacity: .75; margin-right: 3px; }
  .cal-mode { margin-left: auto; display: flex; gap: 0; }
  .cal-mode button { background: var(--color-bg-secondary); border: 1px solid var(--color-border); color: var(--color-text); padding: 4px 12px; font-size: 12px; cursor: pointer; }
  .cal-mode button:first-child { border-radius: 6px 0 0 6px; }
  .cal-mode button:last-child { border-radius: 0 6px 6px 0; border-left: none; }
  .cal-mode button.active { background: var(--color-accent); color: var(--color-on-accent); border-color: var(--color-accent); }
  .grid.week { grid-auto-rows: minmax(260px, 1fr); }
  .not-configured { margin: 40px auto; max-width: 420px; text-align: center; color: var(--color-text-secondary); font-size: 14px; line-height: 1.5; }
  .not-configured h3 { color: var(--color-text); font-size: 16px; margin-bottom: 8px; }

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
  .actions .primary { background: var(--color-accent); color: var(--color-on-accent); border-color: var(--color-accent); }
  .actions .primary:hover { background: var(--color-accent-hover); }
  .actions .danger { background: transparent; color: var(--color-danger); border-color: var(--color-danger); }
  .actions .ghost { background: transparent; }
</style>
