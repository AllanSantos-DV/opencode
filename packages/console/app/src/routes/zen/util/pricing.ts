export function isPeakPricing(date: Date) {
  const hour = date.getUTCHours()
  // DeepSeek defines weekends in Beijing time, which is fixed at UTC+8.
  const dayInBeijing = new Date(date.getTime() + 8 * 60 * 60 * 1000).getUTCDay()
  if (dayInBeijing === 0 || dayInBeijing === 6) return false
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10)
}
