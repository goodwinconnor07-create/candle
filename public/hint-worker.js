// searches for the best move off the main thread, so the board and the
// clocks keep moving while it thinks. only asked once a streak earns it
import { fromFen, bestMove } from './chess.js';

self.onmessage = (e) => {
  const { fen, ms } = e.data;
  const r = bestMove(fromFen(fen), { ms: ms || 1200 });
  self.postMessage(r
    ? { fen, from: r.move.from, to: r.move.to, promo: r.move.promo, san: r.san, mate: r.mate }
    : { fen, none: true });
};
