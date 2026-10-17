-- Room cards, used by the lobby SurfaceGui board and the in-game Rooms panel.
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local TweenService = game:GetService("TweenService")
local Shared = ReplicatedStorage:WaitForChild("Shared")
local Theme = require(Shared.Theme)
local Util = require(Shared.Util)

local Board = {}

local make, label = Theme.make, Theme.label

local function chip(parent: Instance, text: string, filled: boolean, order: number)
	local c = label({
		Text = text, AutomaticSize = Enum.AutomaticSize.X, Size = UDim2.new(0, 0, 1, 0), MaxText = 16,
		TextScaled = false, TextSize = 13, FontFace = Theme.Heading,
		BackgroundTransparency = 0, BackgroundColor3 = if filled then Theme.Accent else Theme.Bg,
		TextColor3 = if filled then Theme.Bg else Theme.Text, LayoutOrder = order,
		TextXAlignment = Enum.TextXAlignment.Center, Parent = parent,
	})
	make("UIPadding", { PaddingLeft = UDim.new(0, 8), PaddingRight = UDim.new(0, 8), Parent = c })
	Theme.corner(6).Parent = c
	if not filled then
		Theme.stroke().Parent = c
	end
	return c
end

local function card(parent: Instance, c: any, current: string?, onClick: (string) -> (), order: number)
	local clickable = c.status == "ready" and not c.measuring
	local btn = make("TextButton", {
		Name = c.id, Text = "", AutoButtonColor = clickable, LayoutOrder = order,
		BackgroundColor3 = Theme.Surface, BackgroundTransparency = 0.05, Parent = parent,
	}, { Theme.corner(14) })
	local stroke = Theme.stroke(if c.id == current then Theme.Accent else Theme.Stroke, if c.id == current then 2 else 1)
	stroke.Parent = btn
	make("UIPadding", { PaddingLeft = UDim.new(0.05, 0), PaddingRight = UDim.new(0.05, 0),
		PaddingTop = UDim.new(0.07, 0), PaddingBottom = UDim.new(0.07, 0), Parent = btn })
	label({ Text = string.upper(c.name or c.id), Size = UDim2.fromScale(1, 0.3), FontFace = Theme.Heading,
		MaxText = 26, Parent = btn })
	local chips = make("Frame", { BackgroundTransparency = 1, Size = UDim2.fromScale(1, 0.18),
		Position = UDim2.fromScale(0, 0.34), Parent = btn }, {
		make("UIListLayout", { FillDirection = Enum.FillDirection.Horizontal, Padding = UDim.new(0, 6),
			SortOrder = Enum.SortOrder.LayoutOrder }),
	})
	chip(chips, c.mode or "PHOTO", false, 1)
	if (c.newUntil or 0) > workspace:GetServerTimeNow() then
		chip(chips, "NEW", true, 2)
	end
	if c.judge then
		chip(chips, "JUDGE IS HERE", true, 3)
	end
	local meta = Util.ageText(c.createdAt)
	if c.blocks then
		meta ..= "  ·  " .. Util.commas(c.blocks) .. " blocks"
	end
	label({ Text = meta, TextColor3 = Theme.Muted, Size = UDim2.fromScale(1, 0.16), Position = UDim2.fromScale(0, 0.56),
		MaxText = 16, Parent = btn })
	local sw = make("Frame", { BackgroundTransparency = 1, Size = UDim2.fromScale(1, 0.18), Position = UDim2.fromScale(0, 0.8),
		Parent = btn }, {
		make("UIListLayout", { FillDirection = Enum.FillDirection.Horizontal, Padding = UDim.new(0, 6) }),
	})
	for _, hex in c.swatches or {} do
		local sq = make("Frame", { Size = UDim2.fromScale(0.15, 1), BackgroundColor3 = Color3.fromHex(hex), Parent = sw },
			{ Theme.corner(4), make("UIAspectRatioConstraint", { AspectRatio = 1 }) })
		Theme.stroke().Parent = sq
	end
	if not clickable then
		local text = if c.measuring then "MEASURING THE ROOM..."
			else "BUILDING · " .. math.floor((c.progress or 0) * 100) .. "%"
		local overlay = make("Frame", { BackgroundColor3 = Theme.Bg, BackgroundTransparency = 0.35,
			Size = UDim2.new(1.12, 0, 1.16, 0), Position = UDim2.new(-0.06, 0, -0.08, 0), ZIndex = 5, Parent = btn },
			{ Theme.corner(14) })
		local l = label({ Text = text, TextColor3 = Theme.Accent, FontFace = Theme.Heading, ZIndex = 6,
			TextXAlignment = Enum.TextXAlignment.Center, Size = UDim2.fromScale(1, 0.3), Position = UDim2.fromScale(0, 0.35),
			Parent = overlay })
		local bar = make("Frame", { BackgroundColor3 = Theme.Stroke, Size = UDim2.new(0.8, 0, 0, 6), ZIndex = 6,
			Position = UDim2.new(0.1, 0, 0.72, 0), Parent = overlay }, { Theme.corner(3) })
		make("Frame", { BackgroundColor3 = Theme.Accent, Size = UDim2.fromScale(math.clamp(c.progress or 0, 0.03, 1), 1),
			ZIndex = 7, Parent = bar }, { Theme.corner(3) })
		TweenService:Create(l, TweenInfo.new(0.8, Enum.EasingStyle.Sine, Enum.EasingDirection.InOut, -1, true),
			{ TextTransparency = 0.6 }):Play()
	else
		btn.Activated:Connect(function()
			onClick(c.id)
		end)
	end
end

-- cards: decoded RoomsJson. Rebuilds the container's children.
function Board.render(container: Instance, cards: { any }, current: string?, onClick: (string) -> ())
	for _, child in container:GetChildren() do
		if child:IsA("GuiObject") then
			child:Destroy()
		end
	end
	if #cards == 0 then
		label({ Text = "No rooms yet. Add a memory in Déjà View.", TextColor3 = Theme.Muted,
			Size = UDim2.fromScale(1, 0.2), Parent = container })
		return
	end
	for i, c in cards do
		card(container, c, current, onClick, i)
	end
end

return Board
