-- One look for every UI: dark, one lime accent, bold type (team/shivin.md 7.6).
local Theme = {}

Theme.Bg = Color3.fromHex("0B0B0F")
Theme.Surface = Color3.fromHex("15151B")
Theme.Stroke = Color3.fromHex("2A2A33")
Theme.Text = Color3.fromHex("F4F4F5")
Theme.Muted = Color3.fromHex("9A9AA6")
Theme.Accent = Color3.fromHex("C6FF3D")
Theme.Danger = Color3.fromHex("FF4D6D")
Theme.Imagined = Color3.fromRGB(255, 61, 200)

Theme.Heading = Font.fromName("BuilderSans", Enum.FontWeight.ExtraBold)
Theme.Body = Font.fromName("BuilderSans", Enum.FontWeight.Bold)

-- Swap these for Roblox-made Creator Store sounds (credit them on Devpost).
Theme.Sounds = {
	tag = "rbxasset://sounds/electronicpingshort.wav",
	tick = "rbxasset://sounds/clickfast.wav",
	win = "rbxasset://sounds/electronicpingshort.wav",
}

-- Tiny instance builder: make("Frame", {props}, {children})
function Theme.make(className: string, props: { [string]: any }?, children: { Instance }?): any
	local inst = Instance.new(className)
	local parent = nil
	for k, v in props or {} do
		if k == "Parent" then
			parent = v
		else
			(inst :: any)[k] = v
		end
	end
	for _, child in children or {} do
		child.Parent = inst
	end
	if parent then
		inst.Parent = parent
	end
	return inst
end

function Theme.corner(px: number?): UICorner
	return Theme.make("UICorner", { CornerRadius = UDim.new(0, px or 14) })
end

function Theme.stroke(color: Color3?, thickness: number?): UIStroke
	return Theme.make("UIStroke", {
		Color = color or Theme.Stroke,
		Thickness = thickness or 1,
		ApplyStrokeMode = Enum.ApplyStrokeMode.Border,
	})
end

function Theme.label(props: { [string]: any }): TextLabel
	local p = {
		BackgroundTransparency = 1,
		TextColor3 = Theme.Text,
		FontFace = Theme.Body,
		TextScaled = true,
		TextXAlignment = Enum.TextXAlignment.Left,
	}
	for k, v in props do
		p[k] = v
	end
	local children = { Theme.make("UITextSizeConstraint", { MaxTextSize = p.MaxText or 28, MinTextSize = 8 }) }
	p.MaxText = nil
	return Theme.make("TextLabel", p, children)
end

function Theme.button(props: { [string]: any }): TextButton
	local p = {
		BackgroundColor3 = Theme.Surface,
		BackgroundTransparency = 0.05,
		TextColor3 = Theme.Text,
		FontFace = Theme.Heading,
		TextScaled = true,
		AutoButtonColor = true,
	}
	for k, v in props do
		p[k] = v
	end
	local maxText = p.MaxText or 20
	p.MaxText = nil
	return Theme.make("TextButton", p, {
		Theme.corner(12),
		Theme.stroke(),
		Theme.make("UITextSizeConstraint", { MaxTextSize = maxText, MinTextSize = 8 }),
		Theme.make("UIPadding", {
			PaddingLeft = UDim.new(0, 10),
			PaddingRight = UDim.new(0, 10),
			PaddingTop = UDim.new(0, 6),
			PaddingBottom = UDim.new(0, 6),
		}),
	})
end

function Theme.toHex(c: Color3): string
	return c:ToHex()
end

return Theme
