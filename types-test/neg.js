// @ts-check
import { Status } from '../otel-compact/src/trace.js';
Status.match(Status.Unset, { Unset: () => 1 });          // expect: missing Error
Status.Error();                                            // expect: arity
Status.match(Status.Error('x'), { Unset: () => 1, Error: (e) => e.mesage.length, Eror: () => 2 }); // expect: unknown case
