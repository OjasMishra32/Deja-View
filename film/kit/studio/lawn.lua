-- Two takes of the hand-built Game Lawn in Studio, one captured frame per step.
--   build: an orbit while the room's parts appear from the floor up (Studio's interface stays in frame)
--   walk:  an eye-level dolly through the patio toward the lawn
local H = game:GetService("HttpService")
local BASE = "http://127.0.0.1:8799"
local function log(m) pcall(function() H:GetAsync(BASE .. "/log?m=" .. H:UrlEncode(m)) end) end
local function shot(take, i) H:GetAsync(("%s/shot?take=%s&i=%d"):format(BASE, take, i)) end
local function settle() for _ = 1, 3 do task.wait() end end

local F = workspace.Film
local floor = F:FindFirstChild("Floor", true)
local glass = F:FindFirstChild("Glass", true)
local centre = floor.Position + Vector3.new(0, floor.Size.Y / 2, 0)
local cam = workspace.CurrentCamera
local parts = {}
for _, p in F:GetDescendants() do if p:IsA("BasePart") then table.insert(parts, p) end end
log(("parts %d centre %s glass %s"):format(#parts, tostring(centre), tostring(glass.Position)))

-- build
local orig = {}
for _, p in parts do orig[p] = p.Transparency; p.Transparency = 1 end
table.sort(parts, function(a, b) return a.Position.Y - a.Size.Y / 2 < b.Position.Y - b.Size.Y / 2 end)
cam.FieldOfView = 40
local N = 210
for i = 0, N - 1 do
  local k = i / (N - 1)
  local shown = math.floor(#parts * math.clamp(k * 1.2, 0, 1))
  for j = 1, shown do local p = parts[j]; if orig[p] < 1 then p.Transparency = orig[p] end end
  local a = math.rad(215 + 60 * k)
  local r = 110 - 30 * k
  local eye = centre + Vector3.new(math.cos(a) * r, 62 - 22 * k, math.sin(a) * r)
  cam.CFrame = CFrame.lookAt(eye, centre + Vector3.new(0, 6, 0))
  settle()
  shot("build", i)
end
for p, t in orig do p.Transparency = t end
log("build done")

-- walk: from the glass side toward the open lawn, eye height 1.6 m
local toLawn = Vector3.new(centre.X - glass.Position.X, 0, centre.Z - glass.Position.Z).Unit
local side = toLawn:Cross(Vector3.new(0, 1, 0))
cam.FieldOfView = 55
local M = 240
for i = 0, M - 1 do
  local k = i / (M - 1)
  local s = k * k * (3 - 2 * k)
  local eye = centre - toLawn * (14 - 16 * s) + side * (5 - 7 * s) + Vector3.new(0, 5.7, 0)
  cam.CFrame = CFrame.lookAt(eye, eye + toLawn * 20 + side * (-4 + 6 * s) + Vector3.new(0, -1.2, 0))
  settle()
  shot("walk", i)
end
log("walk done")
