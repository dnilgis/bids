/* Its own file so lib/adapters/index.mjs can name the refusal without pulling
   in the adapter, and so isRefusal()'s structural test in board.mjs -- which
   matches any class whose name ends in "Refused" -- keeps working. */
export class BushelRefused extends Error {}
