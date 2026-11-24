// 页面卸载清理注册表：路由切换前统一释放渲染器、RAF、观察器等资源
const cleaners: (() => void)[] = []

export const registerCleaner = (fn: () => void): void => {
  cleaners.push(fn)
}

export const runCleaners = (): void => {
  while (cleaners.length) {
    const fn = cleaners.pop()
    if (!fn) continue
    try {
      fn()
    } catch (err) {
      console.warn('页面清理失败', err)
    }
  }
}
