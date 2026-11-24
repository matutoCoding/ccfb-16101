// 菌棒生命周期状态。数值即 GPU 存储中的编码，顺序不要随意调整
export enum StickStatus {
  SpawnRun = 0, // 发菌：棒面白色菌丝
  ColorChange = 1, // 转色：棕褐斑块逐步连片
  BudInduce = 2, // 催蕾
  Fruiting = 3, // 出菇：棒面冒菇蕾与菇体
  Resting = 4, // 养菌
  Watering = 5, // 补水
  GreenMold = 6, // 绿霉污染
  Scrapped = 7, // 报废
}

export const STATUS_COUNT = 8

// 各状态默认停留天数（出菇/养菌/补水构成潮次循环）
export const STATUS_DURATION_DAYS: Record<StickStatus, number> = {
  [StickStatus.SpawnRun]: 35,
  [StickStatus.ColorChange]: 12,
  [StickStatus.BudInduce]: 4,
  [StickStatus.Fruiting]: 7,
  [StickStatus.Resting]: 10,
  [StickStatus.Watering]: 2,
  [StickStatus.GreenMold]: 9999,
  [StickStatus.Scrapped]: 9999,
}

export const STATUS_LABEL: Record<StickStatus, string> = {
  [StickStatus.SpawnRun]: '发菌',
  [StickStatus.ColorChange]: '转色',
  [StickStatus.BudInduce]: '催蕾',
  [StickStatus.Fruiting]: '出菇',
  [StickStatus.Resting]: '养菌',
  [StickStatus.Watering]: '补水',
  [StickStatus.GreenMold]: '绿霉',
  [StickStatus.Scrapped]: '报废',
}

// 三维与拾取色板中的统一颜色（线性 sRGB，0-1）
export const STATUS_COLOR: Record<StickStatus, [number, number, number]> = {
  [StickStatus.SpawnRun]: [0.93, 0.91, 0.86],
  [StickStatus.ColorChange]: [0.45, 0.3, 0.18],
  [StickStatus.BudInduce]: [0.52, 0.37, 0.25],
  [StickStatus.Fruiting]: [0.55, 0.4, 0.28],
  [StickStatus.Resting]: [0.48, 0.36, 0.26],
  [StickStatus.Watering]: [0.4, 0.32, 0.26],
  [StickStatus.GreenMold]: [0.28, 0.55, 0.2],
  [StickStatus.Scrapped]: [0.32, 0.3, 0.28],
}

export interface GreenhouseLayout {
  lengthM: number // 棚长（米，沿 X）
  widthM: number // 棚宽（米，沿 Z）
  shelfRows: number // 层架排数（横向并排）
  tiers: number // 层数（垂直）
  cols: number // 每层每排码放列数（沿棚长）
  aisleM: number // 排间通道宽
}

export interface Greenhouse {
  id: number
  code: string // 棚号，如 P03
  layout: GreenhouseLayout
  // 温湿度，驱动绿霉概率
  tempC: number
  humidity: number // 0-1
  createdAt: string
}

export interface Batch {
  id: number
  code: string // 批次号，如 B20261003-02
  variety: string // 品种
  inoculatedAt: string // 接种日期 YYYY-MM-DD
  baseWeightG: number // 接种时棒重
  targetWeightG: number // 标准棒重（补水目标）
  count: number // 批次菌棒总数
}

export interface Stick {
  id: number // 全基地唯一，等价于全局实例序号
  code: string // 档案编号 S000123
  batchId: number
  greenhouseId: number
  slotIndex: number // 棚内格位序号，-1 表示未上架
  weightG: number
  // 状态机
  status: StickStatus
  statusDay: number // 当前状态已停留天数
  ageDays: number // 菌龄（接种起算）
  moisture: number // 含水率 0-1
  flushNo: number // 潮次
  fruitingDays: number // 本潮累计出菇天数，驱动菇体大小
  // 转色进度 0-1，进入转色后逐天增长，外观斑块连片用
  colorProgress: number
  // 绿霉扩散用：污染天数，-1 表示健康
  moldDay: number
  scrapped: 0 | 1
}

export type TaskKind = 'water' | 'turn' | 'harvest' | 'clean'

export interface FarmTask {
  id: number
  kind: TaskKind
  greenhouseId: number
  row: number // 层架排，-1 表示整棚
  tier: number // 层，-1 表示全层
  stickCount: number
  dueDate: string
  done: 0 | 1
  note: string
}

export interface TimelineEvent {
  day: number
  status: StickStatus
  moisture: number
  note: string
}

export interface Settings {
  baseName: string
  simulationDay: string // 基地日历当前日期
  moldBaseProb: number // 绿霉基础日感染概率
  moldSpreadRadius: number // 相邻感染半径（格位）
  autoTask: boolean // 是否按状态自动派单
}
