import { h, mount } from './dom'
import { runCleaners } from './cleanup'
import { farmStore } from '@/data/store'
import { generateData } from '@/domain/generator'
import { openDb, idbGet, idbPut, idbClear, loadStickChunks, saveStickChunks, STORE, META } from '@/data/db'
import { overviewPage } from './pages/overview'
import { greenhousePage } from './pages/greenhouse'
import { batchPage } from './pages/batch'
import { inspectPage } from './pages/inspect'
import { taskPage } from './pages/task'
import { settingsPage } from './pages/settings'

export type PageKey = 'overview' | 'greenhouse' | 'batch' | 'inspect' | 'task' | 'settings'

const NAV: { key: PageKey; label: string }[] = [
  { key: 'overview', label: '基地总览' },
  { key: 'greenhouse', label: '大棚档案' },
  { key: 'batch', label: '菌棒批次' },
  { key: 'inspect', label: '三维巡检' },
  { key: 'task', label: '农事任务' },
  { key: 'settings', label: '设置' },
]

export const appState = {
  page: 'overview' as PageKey,
  flyHouse: -1, // 总览点击棚后，巡检页要飞向的棚
  db: null as IDBDatabase | null,
  booting: true,
}

const persistAll = async (): Promise<void> => {
  const db = appState.db
  if (!db) return
  await Promise.all([
    idbPut(db, STORE.meta, farmStore.settings, META.settings),
    idbPut(db, STORE.meta, farmStore.greenhouses, META.greenhouses),
    idbPut(db, STORE.meta, farmStore.batches, META.batches),
    idbPut(db, STORE.meta, farmStore.origins, META.origins),
    idbPut(db, STORE.meta, farmStore.total, META.total),
  ])
  await saveStickChunks(db, farmStore.records, farmStore.total)
}

const boot = async (root: HTMLElement): Promise<void> => {
  root.append(h('div', { class: 'boot-screen' }, '正在初始化菌棒档案，首次生成 40 万根数据约需 1-2 秒...'))
  const db = await openDb()
  appState.db = db
  const initialized = await idbGet<number>(db, STORE.meta, META.initialized)

  if (initialized) {
    const total = (await idbGet<number>(db, STORE.meta, META.total)) ?? 0
    const records = await loadStickChunks(db, total)
    farmStore.load({
      records,
      total,
      greenhouses: (await idbGet(db, STORE.meta, META.greenhouses)) ?? [],
      batches: (await idbGet(db, STORE.meta, META.batches)) ?? [],
      origins: (await idbGet(db, STORE.meta, META.origins)) ?? [],
      settings: (await idbGet(db, STORE.meta, META.settings)) ?? generateData().settings,
    })
  } else {
    const data = generateData()
    farmStore.load(data)
    await persistAll()
    await idbPut(db, STORE.meta, 1, META.initialized)
  }
  farmStore.refreshTasks()
  appState.booting = false
  render(root)
}

const render = (root: HTMLElement): void => {
  runCleaners()
  const pageHost = h('div', { class: 'page-host' })
  const navButtons = NAV.map((n) =>
    h(
      'button',
      {
        class: `nav-item${appState.page === n.key ? ' active' : ''}`,
        dataset: { page: n.key },
        onclick: () => {
          appState.page = n.key
          render(root)
        },
      },
      n.label,
    ),
  )

  const shell = h(
    'div',
    { class: 'app-shell' },
    h(
      'aside',
      { class: 'sidebar' },
      h('div', { class: 'brand' }, h('div', { class: 'brand-mark' }), h('div', { class: 'brand-text' }, '菌棒档案台', h('div', { class: 'brand-sub muted' }, farmStore.settings?.baseName ?? ''))),
      h('nav', { class: 'nav' }, ...navButtons),
      h('div', { class: 'sidebar-foot muted' }, `数据日期 ${farmStore.settings?.simulationDay ?? '-'}`),
    ),
    h(
      'main',
      { class: 'main' },
      h('header', { class: 'topbar' }, h('div', { class: 'topbar-title' }, NAV.find((n) => n.key === appState.page)?.label), h('div', { class: 'topbar-actions', id: 'topbar-actions' })),
      pageHost,
    ),
  )
  mount(root, shell)

  const pages = {
    overview: overviewPage,
    greenhouse: greenhousePage,
    batch: batchPage,
    inspect: inspectPage,
    task: taskPage,
    settings: settingsPage,
  }
  pageHost.append(pages[appState.page]())
}

// 全局数据变更后落盘（节流由调用方控制，避免高频写）
let saveTimer: ReturnType<typeof setTimeout> | undefined
export const schedulePersist = (): void => {
  if (!appState.db) return
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    void persistAll()
  }, 800)
}

export const resetAllData = async (): Promise<void> => {
  const db = appState.db
  if (!db) return
  await idbClear(db, STORE.meta)
  await idbClear(db, STORE.stickChunk)
  await idbClear(db, STORE.task)
  const data = generateData(Date.now() & 0xffffffff)
  farmStore.load(data)
  farmStore.refreshTasks()
  await persistAll()
  await idbPut(db, STORE.meta, 1, META.initialized)
  render(document.getElementById('app')!)
}

export const navigate = (page: PageKey): void => {
  appState.page = page
  render(document.getElementById('app')!)
}

export const startApp = (): void => {
  const root = document.getElementById('app')!
  void boot(root)
}
