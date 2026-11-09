import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { installRoom } from "../web/app/native-room.js";

const interpreter = process.env.TESSERA_S7;
test("room functions survive separate calls through Upsilon’s Scheme wrapper", { skip: !interpreter }, () => {
  const bridgeCall = expression =>
    `(begin (write (catch #t (lambda () (begin ${expression})) (lambda args (cons 'error args)))) (newline))`;
  const result = execFileSync(interpreter, [
    "-c", bridgeCall(installRoom),
    "-c", bridgeCall("(and (procedure? tessera-start) (procedure? tessera-receive) (null? tessera-pending))"),
  ], { encoding: "utf8" });
  assert.doesNotMatch(result, /\(error /u);
  assert.equal(result.trim().split("\n").at(-1), "#t");
});
