const london = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

function wallTime(date) {
  const p = Object.fromEntries(london.formatToParts(date).map(x => [x.type, x.value]));
  return { date: `${p.year}${p.month}${p.day}`, time: `${p.hour}${p.minute}` };
}

// TfL accepts local date + minute, with no UTC offset. Do not silently choose
// between the two occurrences of a minute during the autumn clock change.
export function journeyTime(at, now = new Date()) {
  const instant = at ? new Date(at) : now;
  if (!Number.isFinite(instant.getTime())) throw new Error('Invalid journey time.');
  const result = wallTime(instant);
  for (const delta of [-3600000, 3600000]) {
    const other = wallTime(new Date(instant.getTime() + delta));
    if (other.date === result.date && other.time === result.time) {
      throw new Error('This London time occurs twice during the clock change. Choose a time outside the repeated hour.');
    }
  }
  return { ...result, requestedAt: instant.toISOString(), timeZone: 'Europe/London' };
}
