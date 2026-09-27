const HLC_PATTERN = /^(\d{13}):(\d{6})$/;

export interface HlcParts {
  wallTime: number;
  counter: number;
}

export function parseHlc(value: string): HlcParts | null {
  const match = HLC_PATTERN.exec(value);
  if (!match) return null;
  const wallTime = Number(match[1]);
  const counter = Number(match[2]);
  return Number.isSafeInteger(wallTime) && Number.isSafeInteger(counter) ? { wallTime, counter } : null;
}

export class HybridLogicalClock {
  private wallTime = 0;
  private counter = 0;

  now(physicalTime = Date.now()): string {
    if (!Number.isSafeInteger(physicalTime) || physicalTime < 0) throw new Error('HLC_PHYSICAL_TIME_INVALID');
    if (physicalTime > this.wallTime) {
      this.wallTime = physicalTime;
      this.counter = 0;
    } else {
      this.counter += 1;
    }
    if (this.counter > 999999) throw new Error('HLC_COUNTER_OVERFLOW');
    return `${String(this.wallTime).padStart(13, '0')}:${String(this.counter).padStart(6, '0')}`;
  }

  observe(remote: string, physicalTime = Date.now()): string {
    const parsed = parseHlc(remote);
    if (!parsed) throw new Error('HLC_REMOTE_INVALID');
    const nextWall = Math.max(this.wallTime, parsed.wallTime, physicalTime);
    if (nextWall === this.wallTime && nextWall === parsed.wallTime)
      this.counter = Math.max(this.counter, parsed.counter) + 1;
    else if (nextWall === this.wallTime) this.counter += 1;
    else if (nextWall === parsed.wallTime) this.counter = parsed.counter + 1;
    else this.counter = 0;
    this.wallTime = nextWall;
    if (this.counter > 999999) throw new Error('HLC_COUNTER_OVERFLOW');
    return `${String(this.wallTime).padStart(13, '0')}:${String(this.counter).padStart(6, '0')}`;
  }
}
