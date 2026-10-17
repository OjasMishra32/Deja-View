-- One-shot transport test: fetch /api/scenes and /api/big from BASE and print sizes and timings.
-- Run from the server console (F9 -> Server): require(game.ServerScriptService.DejaView.TransportTest)()
local HttpService = game:GetService("HttpService")
local Config = require(script.Parent.Config)

return function(base: string?)
	base = base or Config.base()
	for _, path in { "/api/scenes", "/api/big" } do
		local t0 = os.clock()
		local ok, res = pcall(HttpService.RequestAsync, HttpService, { Url = base .. path, Method = "GET" })
		if not ok then
			warn("[TransportTest]", path, "FAILED:", res)
			continue
		end
		local okJson, data = pcall(HttpService.JSONDecode, HttpService, res.Body)
		local count = if okJson and type(data) == "table" then (if data.parts then #data.parts else #data) else "?"
		print(string.format("[TransportTest] %s -> %d, %d bytes, %s items, %.2fs", path, res.StatusCode, #res.Body,
			tostring(count), os.clock() - t0))
	end
end
