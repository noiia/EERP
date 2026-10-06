package mail

import (
	"bytes"
	"regexp"
	"strings"

	"golang.org/x/net/html"
	"golang.org/x/net/html/atom"
)

// Template bodies are admin-authored HTML that lands in mail clients, so they
// are reduced to a small allowlist on save: formatting, lists, headings and
// links. Anything else is unwrapped (its text kept) or, for script-like
// elements, dropped with its content. Attributes are dropped except a link's
// href, which must be http(s), mailto, or a {{placeholder}}.

var allowedTags = map[atom.Atom]bool{
	atom.P: true, atom.Br: true, atom.Strong: true, atom.B: true, atom.Em: true, atom.I: true,
	atom.U: true, atom.S: true, atom.A: true, atom.Ul: true, atom.Ol: true, atom.Li: true,
	atom.H1: true, atom.H2: true, atom.H3: true, atom.Blockquote: true, atom.Hr: true,
}

// droppedTags lose their content too: it isn't text a reader should see.
var droppedTags = map[atom.Atom]bool{
	atom.Script: true, atom.Style: true, atom.Iframe: true, atom.Object: true, atom.Embed: true,
	atom.Noscript: true, atom.Template: true, atom.Head: true, atom.Title: true,
}

var safeHref = regexp.MustCompile(`^(https?://|mailto:|\{\{\s*[a-z_]+\s*\}\})`)

func parseFragment(s string) []*html.Node {
	ctx := &html.Node{Type: html.ElementNode, DataAtom: atom.Div, Data: "div"}
	nodes, err := html.ParseFragment(strings.NewReader(s), ctx)
	if err != nil {
		return nil
	}
	return nodes
}

// SanitizeHTML reduces s to the template allowlist.
func SanitizeHTML(s string) string {
	var buf bytes.Buffer
	for _, n := range parseFragment(s) {
		writeSafe(&buf, n)
	}
	return buf.String()
}

func writeSafe(buf *bytes.Buffer, n *html.Node) {
	switch n.Type {
	case html.TextNode:
		buf.WriteString(html.EscapeString(n.Data))
		return
	case html.ElementNode:
	default:
		return // comments, doctypes
	}
	if droppedTags[n.DataAtom] {
		return
	}
	if !allowedTags[n.DataAtom] {
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			writeSafe(buf, c)
		}
		return
	}
	buf.WriteString("<" + n.Data)
	if n.DataAtom == atom.A {
		for _, a := range n.Attr {
			if a.Key == "href" && safeHref.MatchString(strings.TrimSpace(a.Val)) {
				buf.WriteString(` href="` + html.EscapeString(strings.TrimSpace(a.Val)) + `"`)
			}
		}
	}
	buf.WriteString(">")
	if n.DataAtom == atom.Br || n.DataAtom == atom.Hr {
		return
	}
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		writeSafe(buf, c)
	}
	buf.WriteString("</" + n.Data + ">")
}

var (
	blankLines = regexp.MustCompile(`\n{3,}`)
	spaces     = regexp.MustCompile(`\s+`)
	runs       = regexp.MustCompile(` {2,}`)
)

// HTMLToText renders a template body as the plain-text part: paragraphs and
// list items on their own lines, links as "text (url)".
func HTMLToText(s string) string {
	var b strings.Builder
	for _, n := range parseFragment(s) {
		writeText(&b, n)
	}
	lines := strings.Split(b.String(), "\n")
	for i, l := range lines {
		lines[i] = strings.TrimSpace(runs.ReplaceAllString(l, " "))
	}
	return strings.TrimSpace(blankLines.ReplaceAllString(strings.Join(lines, "\n"), "\n\n"))
}

func writeText(b *strings.Builder, n *html.Node) {
	switch n.Type {
	case html.TextNode:
		b.WriteString(spaces.ReplaceAllString(n.Data, " ")) // markup whitespace is not layout
		return
	case html.ElementNode:
	default:
		return
	}
	if droppedTags[n.DataAtom] {
		return
	}
	switch n.DataAtom {
	case atom.Br:
		b.WriteString("\n")
		return
	case atom.Hr:
		b.WriteString("\n---\n")
		return
	case atom.Li:
		b.WriteString("- ")
	}
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		writeText(b, c)
	}
	switch n.DataAtom {
	case atom.A:
		for _, a := range n.Attr {
			if a.Key == "href" && a.Val != "" && a.Val != textOf(n) {
				b.WriteString(" (" + a.Val + ")")
			}
		}
	case atom.Li:
		b.WriteString("\n")
	case atom.P, atom.H1, atom.H2, atom.H3, atom.Blockquote, atom.Ul, atom.Ol, atom.Div:
		b.WriteString("\n\n")
	}
}

func textOf(n *html.Node) string {
	var b strings.Builder
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		if c.Type == html.TextNode {
			b.WriteString(c.Data)
		}
	}
	return strings.TrimSpace(b.String())
}
