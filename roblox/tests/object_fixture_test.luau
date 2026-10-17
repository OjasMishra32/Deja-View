-- The baked kitchen fallback must plan the same fridge the pipeline produced.
local ObjectFixtures = require("../src/shared/ObjectFixtures")
local ObjectLayout = require("../src/shared/ObjectLayout")

local failures = 0
local function check(name: string, ok: boolean, detail: string?)
	if ok then
		print(`PASS  {name}`)
	else
		failures += 1
		print(`FAIL  {name}  {detail or ""}`)
	end
end

check("kitchen has a fallback", ObjectFixtures.kitchen ~= nil)
local plan = ObjectLayout.plan(ObjectFixtures.kitchen, { inflate = 0.15 })
check("one fridge is planned", #plan.objects == 1, `n={#plan.objects}`)
check("the fridge is white", plan.objects[1].color[1] == 245 and plan.objects[1].color[3] == 242)
check(
	"the fridge is about 1.65 m tall",
	math.abs(plan.objects[1].size[2] - 6.183) < 0.01,
	`h={plan.objects[1].size[2]}`
)
check("the style is flat", plan.style == "flat")

print(`\n{if failures == 0 then "ALL PASS" else "FAILURES"}  ({failures} failure(s))`)
if failures > 0 then
	error(`fixture failures: {failures}`)
end
