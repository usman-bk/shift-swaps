function parts(timeZone: string) {
  return {
    day: new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', day: 'numeric', month: 'short' }),
    time: new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }),
  };
}

/** A shift's times on the team's clock, wherever the browser happens to be. */
export function span(start: string, end: string, timeZone: string): string {
  const { day, time } = parts(timeZone);
  const [from, to] = [new Date(start), new Date(end)];
  const nextDay = day.format(from) !== day.format(to);
  return `${day.format(from).replace(',', '')}, ${time.format(from)} to ${time.format(to)}${nextDay ? ' next day' : ''}`;
}
