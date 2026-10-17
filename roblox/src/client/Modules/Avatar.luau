-- The judge as a person (team/shivin.md Update 4, item 4): an R15 rig that stands at the judge's feet, turns with the
-- headset's yaw, looks where the head looks and reaches for the controller positions with IKControl. The rig itself
-- is made once by the server (ReplicatedStorage.Assets.JudgeRig); each client clones it locally and drives it.
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Avatar = {}

-- Roblox's own R15 animations (the default Animate set).
local WALK_ANIM = "rbxassetid://507777826"
local IDLE_ANIM = "rbxassetid://507766388"

export type Rig = {
	model: Model,
	root: BasePart,
	humanoid: Humanoid,
	hip: number, -- root centre above the feet
	lTarget: Attachment,
	rTarget: Attachment,
	lookTarget: Attachment,
	targets: BasePart,
	walk: AnimationTrack?,
	idle: AnimationTrack?,
	lastPos: Vector3?,
	speed: number,
	scaled: boolean,
	ikL: IKControl,
	ikR: IKControl,
}

local function template(): Model?
	local assets = ReplicatedStorage:FindFirstChild("Assets")
	local rig = assets and assets:FindFirstChild("JudgeRig")
	return if rig and rig:IsA("Model") then rig else nil
end

function Avatar.available(): boolean
	return template() ~= nil
end

local function ik(humanoid: Humanoid, kind: Enum.IKControlType, root: Instance?, effector: Instance?, target: Instance)
	local c = Instance.new("IKControl")
	c.Type = kind
	c.ChainRoot = root
	c.EndEffector = effector
	c.Target = target
	c.SmoothTime = 0.06
	c.Weight = 1
	c.Parent = humanoid
	return c
end

-- Builds a rig under `parent` (the ghost's model, so its Highlight outlines the person). nil if no template.
function Avatar.create(parent: Instance): Rig?
	local t = template()
	if not t then
		return nil
	end
	local model = t:Clone()
	model.Name = "JudgeAvatar"
	for _, d in model:GetDescendants() do
		if d:IsA("BaseScript") then
			d:Destroy()
		elseif d:IsA("BasePart") then
			d.CanCollide, d.CanQuery, d.CanTouch = false, false, false
			d.Massless = true
			d.CastShadow = false
			d.Anchored = false
		end
	end
	local humanoid = model:FindFirstChildOfClass("Humanoid") :: Humanoid
	local root = model:FindFirstChild("HumanoidRootPart") :: BasePart
	if not humanoid or not root then
		model:Destroy()
		return nil
	end
	root.Anchored = true
	root.Transparency = 1
	humanoid.EvaluateStateMachine = false -- we place it; no physics fighting us
	humanoid.DisplayDistanceType = Enum.HumanoidDisplayDistanceType.None
	local animator = humanoid:FindFirstChildOfClass("Animator") or Instance.new("Animator")
	animator.Parent = humanoid

	-- Invisible anchored carrier for the IK targets.
	local targets = Instance.new("Part")
	targets.Name = "IKTargets"
	targets.Anchored, targets.CanCollide, targets.CanQuery, targets.CanTouch = true, false, false, false
	targets.Transparency = 1
	targets.Size = Vector3.one
	targets.CFrame = CFrame.new()
	targets.Parent = model
	local function att(name: string): Attachment
		local a = Instance.new("Attachment")
		a.Name = name
		a.Parent = targets
		return a
	end
	local lTarget, rTarget, lookTarget = att("LeftHand"), att("RightHand"), att("Look")

	local ikL = ik(humanoid, Enum.IKControlType.Position, model:FindFirstChild("LeftUpperArm"), model:FindFirstChild("LeftHand"), lTarget)
	local ikR = ik(humanoid, Enum.IKControlType.Position, model:FindFirstChild("RightUpperArm"), model:FindFirstChild("RightHand"), rTarget)
	ik(humanoid, Enum.IKControlType.LookAt, model:FindFirstChild("UpperTorso"), model:FindFirstChild("Head"), lookTarget)

	model.Parent = parent
	local hip = humanoid.HipHeight + root.Size.Y / 2

	local rig: Rig = {
		model = model, root = root, humanoid = humanoid, hip = hip,
		lTarget = lTarget, rTarget = rTarget, lookTarget = lookTarget, targets = targets,
		walk = nil, idle = nil, lastPos = nil, speed = 0, scaled = false, ikL = ikL, ikR = ikR,
	}
	pcall(function()
		local walkAnim = Instance.new("Animation")
		walkAnim.AnimationId = WALK_ANIM
		local idleAnim = Instance.new("Animation")
		idleAnim.AnimationId = IDLE_ANIM
		local idle = animator:LoadAnimation(idleAnim)
		rig.walk = animator:LoadAnimation(walkAnim)
		rig.idle = idle
		idle:Play(0.2)
	end)
	return rig
end

-- Scales the rig once so its eyes sit at the judge's real head height.
local function scaleTo(rig: Rig, eyeHeight: number)
	rig.scaled = true
	local head = rig.model:FindFirstChild("Head") :: BasePart?
	if not head then
		return
	end
	local feetY = rig.root.Position.Y - rig.hip
	local current = head.Position.Y - feetY
	if current <= 0.5 then
		return
	end
	local factor = math.clamp(eyeHeight / current, 0.75, 1.5)
	pcall(function()
		rig.model:ScaleTo(rig.model:GetScale() * factor)
	end)
	rig.hip = rig.humanoid.HipHeight + rig.root.Size.Y / 2
end

-- s: an Interp sample (feet pos, yaw, head, hl, hr). dt: frame time.
function Avatar.update(rig: Rig, s: any, dt: number)
	local yawCf = CFrame.Angles(0, s.yaw, 0)
	local rootPos = s.pos + Vector3.new(0, rig.hip, 0)
	rig.root.CFrame = CFrame.new(rootPos) * yawCf
	local head = s.head or (s.pos + Vector3.new(0, 5.7, 0))
	if not rig.scaled then
		scaleTo(rig, head.Y - s.pos.Y)
		rootPos = s.pos + Vector3.new(0, rig.hip, 0)
		rig.root.CFrame = CFrame.new(rootPos) * yawCf
	end

	-- Hands reach for the controllers; with no controllers, let the arms hang (IK off).
	rig.ikL.Enabled = s.hl ~= nil
	rig.ikR.Enabled = s.hr ~= nil
	if s.hl then
		rig.lTarget.WorldPosition = s.hl
	end
	if s.hr then
		rig.rTarget.WorldPosition = s.hr
	end
	rig.lookTarget.WorldPosition = head + yawCf.LookVector * 10

	-- Walk while the feet move, idle otherwise.
	if rig.lastPos and dt > 0 then
		local v = Vector3.new(s.pos.X - rig.lastPos.X, 0, s.pos.Z - rig.lastPos.Z).Magnitude / dt
		rig.speed += (v - rig.speed) * math.min(1, dt * 6)
	end
	rig.lastPos = s.pos
	if rig.walk and rig.idle then
		local moving = rig.speed > 1.2
		if moving and not rig.walk.IsPlaying then
			rig.walk:Play(0.2)
			rig.idle:Stop(0.2)
		elseif not moving and rig.walk.IsPlaying then
			rig.walk:Stop(0.25)
			rig.idle:Play(0.25)
		end
		if moving then
			rig.walk:AdjustSpeed(math.clamp(rig.speed / 12, 0.4, 1.6))
		end
	end
end

function Avatar.setTransparency(rig: Rig, t: number)
	for _, d in rig.model:GetDescendants() do
		if d:IsA("BasePart") and d ~= rig.root and d ~= rig.targets then
			d.LocalTransparencyModifier = t
		end
	end
end

return Avatar
