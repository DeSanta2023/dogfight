// npm run tick-demo  — setInterval vs the target-time Ticker, same load, same duration.
import { Ticker } from '../ticker.ts';

const SECONDS = Number(process.argv[2] ?? 10);
const HZ = 30;
const work = (ms) => {
  const end = performance.now() + ms;
  while (performance.now() < end); // pretend the simulation costs a little CPU
};

function viaInterval() {
  return new Promise((resolve) => {
    let steps = 0;
    const start = performance.now();
    const id = setInterval(() => {
      steps++;
      work(2);
      if (performance.now() - start >= SECONDS * 1000) {
        clearInterval(id);
        resolve(steps / ((performance.now() - start) / 1000));
      }
    }, 1000 / HZ);
  });
}

function viaTicker() {
  return new Promise((resolve) => {
    const start = performance.now();
    const ticker = new Ticker({
      hz: HZ,
      onTick: () => {
        work(2);
        if (performance.now() - start >= SECONDS * 1000) {
          ticker.stop();
          resolve({
            ...ticker.stats(),
            rate: ticker.tick / ((performance.now() - start) / 1000),
          });
        }
      },
    });
    ticker.start();
  });
}

const keepAlive = setInterval(() => {}, 1e6); // the Ticker's timer is unref'd on purpose
console.log(`${HZ} steps/s wanted, ${SECONDS} s each, 2 ms of work per step\n`);
const a = await viaInterval();
console.log(`setInterval(fn, 1000/${HZ})   ${a.toFixed(2)} steps/s`);
const b = await viaTicker();
console.log(
  `Ticker (target time)         ${b.rate.toFixed(2)} steps/s   late mean ${b.meanLateMs} ms, max ${b.maxLateMs} ms, skipped ${b.skipped}`,
);
clearInterval(keepAlive);
