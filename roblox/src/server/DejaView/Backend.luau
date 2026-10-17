-- Picks MockServer or Api per call, so "use_mock" can flip live from Experience Configs.
local Config = require(script.Parent.Config)
local Api = require(script.Parent.Api)
local MockServer = require(script.Parent.MockServer)

local Backend = {}

local function impl()
	return if Config.useMock() then MockServer else Api
end

function Backend.scenes()
	return impl().scenes()
end

function Backend.map(sceneId: string, maxParts: number?)
	return impl().map(sceneId, maxParts)
end

function Backend.presence(sceneId: string, body: any)
	return impl().presence(sceneId, body)
end

function Backend.event(sceneId: string, body: any)
	return impl().event(sceneId, body)
end

function Backend.people(sceneId: string)
	return impl().people(sceneId)
end

-- Event delivery: retry up to 3 times with a 1 s gap, then drop (contract 5.4).
function Backend.sendEvent(sceneId: string, body: any)
	task.spawn(function()
		for attempt = 1, 4 do
			local ok, res, status = Backend.event(sceneId, body)
			if ok then
				return
			end
			warn("[DejaView] event failed (" .. tostring(status) .. "):", res, "attempt", attempt)
			if attempt < 4 then
				task.wait(1)
			end
		end
	end)
end

return Backend
