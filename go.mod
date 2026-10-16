module videoeditor

go 1.25.0

require (
	github.com/google/uuid v1.6.0
	github.com/wailsapp/wails/v2 v2.16.0
)

require (
	git.sr.ht/~jackmordaunt/go-toast/v2 v2.0.3 // indirect
	github.com/bep/debounce v1.2.1 // indirect
	github.com/go-ole/go-ole v1.3.0 // indirect
	github.com/godbus/dbus/v5 v5.1.0 // indirect
	github.com/gorilla/websocket v1.5.3 // indirect
	github.com/jchv/go-winloader v0.0.0-20210711035445-715c2860da7e // indirect
	github.com/labstack/echo/v4 v4.13.3 // indirect
	github.com/labstack/gommon v0.4.2 // indirect
	github.com/leaanthony/go-ansi-parser v1.6.1 // indirect
	github.com/leaanthony/gosod v1.0.4 // indirect
	github.com/leaanthony/slicer v1.6.0 // indirect
	github.com/leaanthony/u v1.1.1 // indirect
	github.com/mattn/go-colorable v0.1.13 // indirect
	github.com/mattn/go-isatty v0.0.20 // indirect
	github.com/pkg/browser v0.0.0-20240102092130-5ac0b6a4141c // indirect
	github.com/pkg/errors v0.9.1 // indirect
	github.com/rivo/uniseg v0.4.7 // indirect
	github.com/samber/lo v1.49.1 // indirect
	github.com/tkrajina/go-reflector v0.5.8 // indirect
	github.com/valyala/bytebufferpool v1.0.0 // indirect
	github.com/valyala/fasttemplate v1.2.2 // indirect
	github.com/wailsapp/go-webview2 v1.0.22 // indirect
	github.com/wailsapp/mimetype v1.4.1 // indirect
	golang.org/x/crypto v0.53.0 // indirect
	golang.org/x/net v0.56.0 // indirect
	golang.org/x/sys v0.46.0 // indirect
	golang.org/x/text v0.39.0 // indirect
)

// golang.org isn't reachable from this build environment's network
// allowlist (only github.com is), so x/ packages are routed to their
// GitHub mirrors instead of their vanity import paths. Harmless
// elsewhere - golang.org/x/* packages are mirrored 1:1 on GitHub.
replace (
	golang.org/x/crypto => github.com/golang/crypto v0.23.0
	golang.org/x/exp => github.com/golang/exp v0.0.0-20230522175609-2e198f4a06a1
	golang.org/x/mod => github.com/golang/mod v0.14.0
	golang.org/x/net => github.com/golang/net v0.25.0
	golang.org/x/sync => github.com/golang/sync v0.1.0
	golang.org/x/sys => github.com/golang/sys v0.20.0
	golang.org/x/term => github.com/golang/term v0.20.0
	golang.org/x/text => github.com/golang/text v0.15.0
	golang.org/x/tools => github.com/golang/tools v0.6.0
	gopkg.in/check.v1 => github.com/go-check/check v0.0.0-20180628173108-788fd7840127
	gopkg.in/yaml.v3 => github.com/go-yaml/yaml v0.0.0-20220521103104-8f96da9f5d5e
)
