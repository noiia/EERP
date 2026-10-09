package devseed

import (
	"bytes"
	"context"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"math"

	"core/internal/pictures"
	"core/orm"

	"github.com/google/uuid"
)

// SampleStore is where the seed uploads its sample pictures (the picture
// service's object store).
type SampleStore interface {
	Put(ctx context.Context, key, contentType string, size int64, body io.Reader) error
}

// sampleKind is a family of generated sample pictures.
type sampleKind string

const (
	kindPhoto     sampleKind = "photo"     // landscape: sky, sun, hills
	kindLogo      sampleKind = "logo"      // rounded square badge
	kindSignature sampleKind = "signature" // handwriting-like stroke
)

// pictureTarget is one picture field the full volume fills: every seeded row
// of `ids` (a SELECT id … for the tenant $1) gets a picture on (table, field),
// and the row's `flag` column (if any) is set — the picture field's
// "true ⇔ a picture exists" contract.
type pictureTarget struct {
	group, table, field, flag string
	kind                      sampleKind
	ids                       string
}

var pictureTargets = []pictureTarget{
	{"base", "company", "logo", "logo", kindLogo, `SELECT id FROM company WHERE tenant_id = $1 AND name LIKE 'Northwind %'`},
	{"products", "product", "picture", "picture", kindPhoto, `SELECT id FROM product WHERE tenant_id = $1 AND reference LIKE 'SEED-%'`},
	{"products", "product_variant", "picture", "picture", kindPhoto, `SELECT v.id FROM product_variant v JOIN product p ON p.id = v.product_id
		WHERE v.tenant_id = $1 AND p.reference LIKE 'SEED-%'`},
	{"crm", "crm", "picture", "picture", kindPhoto, `SELECT id FROM crm WHERE tenant_id = $1 AND email LIKE '%.seed.example'`},
	{"crm", "crm", "signature", "signature", kindSignature, `SELECT id FROM crm WHERE tenant_id = $1 AND email LIKE '%.seed.example'`},
	{"quotes", "quote", "logo", "logo", kindLogo, `SELECT id FROM quote WHERE tenant_id = $1 AND number LIKE 'SQ-%'`},
	{"invoices", "invoice", "logo", "logo", kindLogo, `SELECT id FROM invoice WHERE tenant_id = $1 AND number LIKE 'SI-%'`},
	// Photo rows have no flag: the row itself is the carousel slide.
	{"property", "property_management_photo", "picture", "", kindPhoto, `SELECT ph.id FROM property_management_photo ph
		JOIN property_management p ON p.id = ph.property_management_id WHERE ph.tenant_id = $1 AND p.name LIKE 'Seed property %'`},
	{"events", "event", "picture", "picture", kindPhoto, `SELECT id FROM event WHERE tenant_id = $1 AND name LIKE 'Seed event %'`},
}

// samplesPerKind: how many distinct pictures each kind cycles through.
var samplesPerKind = map[sampleKind]int{kindPhoto: 8, kindLogo: 6, kindSignature: 4}

// seedPictures uploads the tenant's sample pool (idempotent keys, see
// pictures.SampleDir) and anchors one sample on every seeded row of the groups
// seeded now: set-based picture rows, each row picking a sample by a hash of
// its id. Properties first get 3 photo rows each (their Photos carousel).
func seedPictures(ctx context.Context, tx *orm.Tx, store SampleStore, tenant uuid.UUID, seeded map[string]bool) ([]Result, error) {
	type sample struct {
		keys  []string
		sizes []int64
	}
	pool := map[sampleKind]sample{}
	for kind, n := range samplesPerKind {
		var s sample
		for i := range n {
			data, err := renderSample(kind, i)
			if err != nil {
				return nil, err
			}
			key := pictures.SampleKey(tenant.String(), fmt.Sprintf("%s-%d.png", kind, i+1))
			if err := store.Put(ctx, key, "image/png", int64(len(data)), bytes.NewReader(data)); err != nil {
				return nil, fmt.Errorf("devseed: upload sample %s: %w", key, err)
			}
			s.keys, s.sizes = append(s.keys, key), append(s.sizes, int64(len(data)))
		}
		pool[kind] = s
	}

	var results []Result
	if seeded["property"] {
		tag, err := tx.Exec(ctx, `INSERT INTO property_management_photo (tenant_id, property_management_id, position)
			SELECT $1, p.id, k FROM property_management p CROSS JOIN generate_series(0, 2) AS k
			WHERE p.tenant_id = $1 AND p.name LIKE 'Seed property %'`, tenant)
		if err != nil {
			return nil, fmt.Errorf("devseed: property photos: %w", err)
		}
		results = append(results, Result{Entity: "property_management_photo", Created: tag.RowsAffected()})
	}
	var total int64
	for _, t := range pictureTargets {
		if !seeded[t.group] {
			continue
		}
		s := pool[t.kind]
		tag, err := tx.Exec(ctx, fmt.Sprintf(`
INSERT INTO picture (tenant_id, table_name, record_id, field, object_key, mime, size)
SELECT $1, '%s', r.id, '%s', ($2::text[])[k.i], 'image/png', ($3::bigint[])[k.i]
FROM (%s) r CROSS JOIN LATERAL (SELECT 1 + abs(hashtext(r.id::text)) %% cardinality($2::text[]) AS i) k
ON CONFLICT DO NOTHING`, t.table, t.field, t.ids), tenant, s.keys, s.sizes)
		if err != nil {
			return nil, fmt.Errorf("devseed: %s.%s pictures: %w", t.table, t.field, err)
		}
		total += tag.RowsAffected()
		if t.flag != "" {
			if _, err := tx.Exec(ctx, fmt.Sprintf(`UPDATE %s SET %s = true WHERE id IN (%s)`, t.table, t.flag, t.ids), tenant); err != nil {
				return nil, fmt.Errorf("devseed: %s.%s flag: %w", t.table, t.flag, err)
			}
		}
	}
	if total > 0 {
		results = append(results, Result{Entity: "picture", Created: total})
	}
	return results, nil
}

// renderSample draws sample i of kind as a PNG. Deterministic: same bytes
// every run, so re-uploading a sample key changes nothing.
func renderSample(kind sampleKind, i int) ([]byte, error) {
	hue := float64(i) * 360 / float64(samplesPerKind[kind])
	var img *image.NRGBA
	switch kind {
	case kindPhoto:
		img = drawPhoto(640, 400, hue, i)
	case kindLogo:
		img = drawLogo(256, hue, i)
	default:
		img = drawSignature(400, 120, i)
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return nil, fmt.Errorf("devseed: encode sample: %w", err)
	}
	return buf.Bytes(), nil
}

// hsl converts hue (degrees), saturation and lightness (0..1) to a color.
func hsl(h, s, l float64) color.NRGBA {
	c := (1 - math.Abs(2*l-1)) * s
	hp := math.Mod(h, 360) / 60
	x := c * (1 - math.Abs(math.Mod(hp, 2)-1))
	var r, g, b float64
	switch {
	case hp < 1:
		r, g = c, x
	case hp < 2:
		r, g = x, c
	case hp < 3:
		g, b = c, x
	case hp < 4:
		g, b = x, c
	case hp < 5:
		r, b = x, c
	default:
		r, b = c, x
	}
	m := l - c/2
	to := func(v float64) uint8 { return uint8(math.Round((v + m) * 255)) }
	return color.NRGBA{to(r), to(g), to(b), 255}
}

// drawPhoto: a sky gradient, a sun and two layers of hills, tinted by hue.
func drawPhoto(w, h int, hue float64, seed int) *image.NRGBA {
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	sunX, sunY, sunR := float64(w)*(0.2+0.6*float64(seed%5)/4), float64(h)*0.32, float64(h)*0.11
	phase := float64(seed) * 1.7
	for y := range h {
		t := float64(y) / float64(h)
		sky := hsl(hue+200, 0.55, 0.78-0.25*(1-t))
		for x := range w {
			px := sky
			if math.Hypot(float64(x)-sunX, float64(y)-sunY) < sunR {
				px = hsl(hue+40, 0.9, 0.75)
			}
			fx := float64(x) / float64(w)
			if float64(y) > float64(h)*(0.62+0.08*math.Sin(fx*5+phase)) {
				px = hsl(hue+120, 0.35, 0.45)
			}
			if float64(y) > float64(h)*(0.78+0.06*math.Sin(fx*9+phase*2)) {
				px = hsl(hue+130, 0.4, 0.3)
			}
			img.SetNRGBA(x, y, px)
		}
	}
	return img
}

// drawLogo: a rounded square badge with a white ring (or a disc), on transparency.
func drawLogo(size int, hue float64, seed int) *image.NRGBA {
	img := image.NewNRGBA(image.Rect(0, 0, size, size))
	s, r := float64(size), float64(size)*0.22
	bg := hsl(hue, 0.65, 0.45)
	for y := range size {
		for x := range size {
			fx, fy := float64(x)+0.5, float64(y)+0.5
			// distance outside the rounded square's inner rectangle
			dx := math.Max(math.Max(r-fx, fx-(s-r)), 0)
			dy := math.Max(math.Max(r-fy, fy-(s-r)), 0)
			if math.Hypot(dx, dy) > r {
				continue
			}
			px := bg
			d := math.Hypot(fx-s/2, fy-s/2)
			if (seed%2 == 0 && d > s*0.22 && d < s*0.32) || (seed%2 == 1 && d < s*0.2) {
				px = color.NRGBA{255, 255, 255, 255}
			}
			img.SetNRGBA(x, y, px)
		}
	}
	return img
}

// drawSignature: a dark-blue handwriting-like stroke on transparency.
func drawSignature(w, h, seed int) *image.NRGBA {
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	ink := color.NRGBA{20, 40, 110, 255}
	a, b := 2.0+float64(seed), 5.0+float64(seed)*1.3
	for i := 0; i <= 4000; i++ {
		t := float64(i) / 4000
		x := 20 + t*float64(w-40)
		y := float64(h)/2 + float64(h)*0.25*math.Sin(t*a*math.Pi)*math.Cos(t*b)
		for oy := -1; oy <= 1; oy++ {
			for ox := -1; ox <= 1; ox++ {
				img.SetNRGBA(int(x)+ox, int(y)+oy, ink)
			}
		}
	}
	return img
}
