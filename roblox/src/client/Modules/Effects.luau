-- Tag burst, camera shake, sounds and the reality-check tint (all local to this client).
local CollectionService = game:GetService("CollectionService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local SoundService = game:GetService("SoundService")
local Theme = require(ReplicatedStorage:WaitForChild("Shared").Theme)

local Effects = {}

function Effects.sound(key: string)
	local id = Theme.Sounds[key]
	if not id or id == "" then
		return
	end
	local s = Instance.new("Sound")
	s.SoundId = id
	s.Volume = 0.7
	s.Parent = SoundService
	SoundService:PlayLocalSound(s)
	task.delay(4, function()
		s:Destroy()
	end)
end

function Effects.burst(pos: Vector3)
	local p = Instance.new("Part")
	p.Anchored, p.CanCollide, p.CanQuery, p.CanTouch = true, false, false, false
	p.Transparency = 1
	p.Size = Vector3.one
	p.CFrame = CFrame.new(pos)
	local e = Instance.new("ParticleEmitter")
	e.Color = ColorSequence.new(Theme.Accent)
	e.LightEmission = 1
	e.Size = NumberSequence.new({ NumberSequenceKeypoint.new(0, 0.6), NumberSequenceKeypoint.new(1, 0) })
	e.Speed = NumberRange.new(12, 24)
	e.SpreadAngle = Vector2.new(180, 180)
	e.Lifetime = NumberRange.new(0.4, 0.9)
	e.Drag = 4
	e.Enabled = false
	e.Parent = p
	p.Parent = workspace
	e:Emit(40)
	task.delay(1.5, function()
		p:Destroy()
	end)
end

function Effects.shake(seconds: number, strength: number)
	local cam = workspace.CurrentCamera
	local t0 = os.clock()
	local conn
	conn = RunService.RenderStepped:Connect(function()
		local t = os.clock() - t0
		if t > seconds then
			conn:Disconnect()
			return
		end
		local k = strength * (1 - t / seconds)
		cam.CFrame *= CFrame.Angles(math.rad((math.random() - 0.5) * k), math.rad((math.random() - 0.5) * k), 0)
	end)
end

local originals: { [BasePart]: Color3 } = {}
local realityOn = false

local function tint(part: Instance)
	if not part:IsA("BasePart") then
		return
	end
	if realityOn then
		if not originals[part] then
			originals[part] = part.Color
		end
		part.Color = originals[part]:Lerp(Theme.Imagined, 0.55):Lerp(Color3.new(0, 0, 0), 0.15)
	elseif originals[part] then
		part.Color = originals[part]
		originals[part] = nil
	end
end

function Effects.setReality(on: boolean)
	realityOn = on
	for _, part in CollectionService:GetTagged("DVImagined") do
		tint(part)
	end
	if not on then
		originals = {}
	end
end

CollectionService:GetInstanceAddedSignal("DVImagined"):Connect(function(part)
	if realityOn then
		tint(part)
	end
end)

return Effects
