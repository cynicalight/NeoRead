package neoread

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNewLibraryExample(t *testing.T) {
	root := t.TempDir()
	s, err := OpenLibrary(root)
	if err != nil {
		t.Fatal(err)
	}
	var paper bundledPaper
	raw, _ := examplePaper.ReadFile("example-paper/paper.json")
	if err = json.Unmarshal(raw, &paper); err != nil {
		t.Fatal(err)
	}
	doc, err := s.Document(paper.ID)
	if err != nil || doc.Title != "Attention Is All You Need" {
		t.Fatalf("document: %v %v", doc, err)
	}
	server := NewServer(s, "test", "")
	layout, err := server.readLayout(paper.ID)
	if err != nil || layout.Pages != 15 {
		t.Fatalf("layout: %v", err)
	}
	translations, err := server.translations(paper.ID, layout)
	if err != nil || len(translations) != 122 {
		t.Fatalf("translations: %d %v", len(translations), err)
	}
	for _, tr := range translations {
		if tr.Status != "complete" {
			t.Fatalf("unfinished translation: %s", tr.BlockID)
		}
	}
	for _, block := range layout.Blocks {
		if block.Image != "" {
			if _, err = os.Stat(filepath.Join(server.analysisDir(paper.ID), block.Image)); err != nil {
				t.Fatal(err)
			}
		}
	}
	p, err := s.processing(paper.ID)
	if err != nil || p.Phase != "ready" || p.Status != "complete" {
		t.Fatalf("processing: %+v %v", p, err)
	}
	var prefs string
	if err = s.DB.QueryRow("SELECT value FROM settings WHERE key='preferences:guide'").Scan(&prefs); err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains([]byte(prefs), []byte(paper.ID)) {
		t.Fatal("missing onboarding example")
	}
	// Restart does not duplicate, and purging every document never seeds or
	// onboards again.
	s.DB.Close()
	s, err = OpenLibrary(root)
	if err != nil {
		t.Fatal(err)
	}
	var count int
	s.DB.QueryRow("SELECT count(*) FROM documents").Scan(&count)
	if count != 1 {
		t.Fatalf("duplicate documents: %d", count)
	}
	if _, err = s.DB.Exec("DELETE FROM documents"); err != nil {
		t.Fatal(err)
	}
	s.DB.Close()
	for range 2 {
		s, err = OpenLibrary(root)
		if err != nil {
			t.Fatal(err)
		}
		s.DB.QueryRow("SELECT count(*) FROM documents").Scan(&count)
		if count != 0 {
			t.Fatal("emptied library was reseeded")
		}
		var onboarded bool
		if err = s.DB.QueryRow("SELECT json_extract(value,'$.onboarded') FROM settings WHERE key='preferences:guide'").Scan(&onboarded); err != nil {
			t.Fatal(err)
		}
		if !onboarded {
			t.Fatal("emptied library triggered onboarding again")
		}
		s.DB.Close()
	}
}

func TestExampleAfterReaderMigration(t *testing.T) {
	for _, external := range []bool{false, true} {
		for _, empty := range []bool{false, true} {
			name := fmt.Sprintf("external=%t/empty=%t", external, empty)
			t.Run(name, func(t *testing.T) {
				old, current, lib := legacyFixture(t, external)
				if empty {
					original, err := OpenStore(lib)
					if err != nil {
						t.Fatal(err)
					}
					if _, err = original.DB.Exec("DELETE FROM documents"); err != nil {
						t.Fatal(err)
					}
					original.DB.Close()
					if err = os.Rename(filepath.Join(lib, "neoread.sqlite"), filepath.Join(lib, "reader.sqlite")); err != nil {
						t.Fatal(err)
					}
				}
				migrated, err := MigrateReaderData(old, current)
				if err != nil {
					t.Fatal(err)
				}
				s, err := OpenLibrary(migrated.Library)
				if err != nil {
					t.Fatal(err)
				}
				defer s.DB.Close()
				var title string
				if err = s.DB.QueryRow("SELECT title FROM documents").Scan(&title); err != nil {
					t.Fatal(err)
				}
				want := "Paper"
				if empty {
					want = "Attention Is All You Need"
				}
				if title != want {
					t.Fatalf("got %s, want %s", title, want)
				}
				var count int
				s.DB.QueryRow("SELECT count(*) FROM documents").Scan(&count)
				if count != 1 {
					t.Fatalf("documents: %d", count)
				}
				var onboarded bool
				if err = s.DB.QueryRow("SELECT json_extract(value,'$.onboarded') FROM settings WHERE key='preferences:guide'").Scan(&onboarded); err != nil {
					t.Fatal(err)
				}
				if onboarded == empty {
					t.Fatalf("onboarded=%t for empty=%t", onboarded, empty)
				}
			})
		}
	}
}

func TestExampleInitializationRecovery(t *testing.T) {
	root := t.TempDir()
	s, err := OpenStore(root)
	if err != nil {
		t.Fatal(err)
	}
	s.DB.Close()
	// Reuse a PDF published by an interrupted initialization, before DB commit.
	raw, _ := examplePaper.ReadFile("example-paper/paper.json")
	var paper bundledPaper
	json.Unmarshal(raw, &paper)
	pdf, _ := examplePaper.ReadFile("example-paper/paper.pdf")
	if err = os.WriteFile(filepath.Join(root, "papers", paper.ID+".pdf"), pdf, 0600); err != nil {
		t.Fatal(err)
	}
	s, err = OpenLibrary(root)
	if err != nil {
		t.Fatal(err)
	}
	s.DB.Close()
	s, err = OpenLibrary(root)
	if err != nil {
		t.Fatal(err)
	}
	defer s.DB.Close()
	var count int
	s.DB.QueryRow("SELECT count(*) FROM documents").Scan(&count)
	if count != 1 {
		t.Fatal("recovery duplicated example")
	}
	var onboarded bool
	if err = s.DB.QueryRow("SELECT json_extract(value,'$.onboarded') FROM settings WHERE key='preferences:guide'").Scan(&onboarded); err != nil {
		t.Fatal(err)
	}
	if !onboarded {
		t.Fatal("existing example triggered onboarding again")
	}
}

func TestExamplePreservesOrphanedLibraryFiles(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "papers", "user.pdf")
	os.MkdirAll(filepath.Dir(path), 0700)
	os.WriteFile(path, []byte("user content"), 0600)
	s, err := OpenLibrary(root)
	if err != nil {
		t.Fatal(err)
	}
	defer s.DB.Close()
	var count int
	s.DB.QueryRow("SELECT count(*) FROM documents").Scan(&count)
	if count != 1 {
		t.Fatal("empty database did not receive example")
	}
	data, _ := os.ReadFile(path)
	if string(data) != "user content" {
		t.Fatal("modified user content")
	}
}

func TestExampleRecoveryPreservesConflictingFile(t *testing.T) {
	root := t.TempDir()
	var paper bundledPaper
	raw, _ := examplePaper.ReadFile("example-paper/paper.json")
	json.Unmarshal(raw, &paper)
	path := filepath.Join(root, "papers", paper.ID+".pdf")
	os.MkdirAll(filepath.Dir(path), 0700)
	os.WriteFile(path, []byte("preserve this file"), 0600)
	if s, err := OpenLibrary(root); err == nil {
		s.DB.Close()
		t.Fatal("overwrote conflicting file")
	}
	raw, _ = os.ReadFile(path)
	if string(raw) != "preserve this file" {
		t.Fatal("user file changed")
	}
	s, err := OpenStore(root)
	if err != nil {
		t.Fatal(err)
	}
	defer s.DB.Close()
	var count int
	s.DB.QueryRow("SELECT count(*) FROM documents").Scan(&count)
	if count != 0 {
		t.Fatal("partial example published")
	}
}

const oldExampleDotProduct = `{
  "status": "complete",
  "blockId": "p4-b12",
  "sourceHash": "15816b813333cdf29b3b937746c13455daa8fa122c11568924b2ff8078d32ec8",
  "sentences": [
    {
      "source": "4 To illustrate why the dot products get large, assume that the components of q and k are independent random variables with mean 0 and variance 1 .",
      "target": "4 为说明点积为何会变大，假设 $q$ 和 $k$ 的各个分量是相互独立的随机变量，均值为 0，方差为 1。"
    },
    {
      "source": "Then their dot product, q · k = P d k q k , has mean 0 and variance d . i =1 i i k",
      "target": "那么，它们的点积 $q \\cdot k = \\sum_{i=1}^{d_k} q_i k_i$ 的均值为 0，方差为 $d_k$。"
    }
  ]
}`

const oldExampleScaling = `{
  "blockId": "p4-b9",
  "sourceHash": "be8e523240e77e3c40e94f1f6ebc54baa22255c0767b4bdab5395c308ea309ea",
  "status": "complete",
  "sentences": [
    {
      "source": "While for small values of d the two mechanisms perform similarly, additive attention outperforms dot product attention without scaling for larger values of d [3].",
      "target": "当 $d_k$ 较小时，这两种机制的表现相近；但当 $d_k$ 较大时，加性注意力的表现优于未进行缩放的点积注意力 [3]。",
      "anchor": "While for small values of d the two mechanisms perform similarly, additive attention outperforms k dot product attention without scaling for larger values of d [3]."
    },
    {
      "source": "We suspect that for large values of d , the dot products grow large in magnitude, pushing the softmax function into regions where it has extremely small gradients 4 .",
      "target": "我们猜测，当 $d_k$ 较大时，点积的绝对值会变大，使 softmax 函数进入梯度极小的区域 4。",
      "anchor": "We suspect that for large values of k d , the dot products grow large in magnitude, pushing the softmax function into regions where it has k extremely small gradients 4 ."
    },
    {
      "source": "To counteract this effect, we scale the dot products by √ 1 . d k",
      "target": "为抵消这种影响，我们将点积缩放为 $\\sqrt{1/d_k}$。",
      "anchor": "To counteract this effect, we scale the dot products by √ 1 . d k"
    }
  ]
}`

func TestExampleRepairsHistoricalTranslationsOnOpen(t *testing.T) {
	root := t.TempDir()
	s, err := OpenLibrary(root)
	if err != nil {
		t.Fatal(err)
	}
	var paper bundledPaper
	data, err := examplePaper.ReadFile("example-paper/paper.json")
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(data, &paper); err != nil {
		t.Fatal(err)
	}
	for _, body := range []string{oldExampleDotProduct, oldExampleScaling} {
		var old TranslationBlock
		if err = json.Unmarshal([]byte(body), &old); err != nil {
			t.Fatal(err)
		}
		if _, err = s.DB.Exec("UPDATE translations SET body=? WHERE document_id=? AND block_id=?", body, paper.ID, old.BlockID); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = s.DB.Exec(`UPDATE documents SET title='My paper',progress='{"page":4}',percentage=0.25,metadata='{"doi":"user-doi"}' WHERE id=?`, paper.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = s.DB.Exec("INSERT INTO annotations(id,document_id,body) VALUES('math-note',?,?)", paper.ID, `{"kind":"highlight","text":"q · k","blockId":"p4-b12"}`); err != nil {
		t.Fatal(err)
	}
	var before string
	if err = s.DB.QueryRow("SELECT json_array(title,progress,percentage,metadata) FROM documents WHERE id=?", paper.ID).Scan(&before); err != nil {
		t.Fatal(err)
	}
	s.DB.Close()
	var repaired string
	for restart := range 2 {
		s, err = OpenLibrary(root)
		if err != nil {
			t.Fatal(err)
		}
		var body string
		if err = s.DB.QueryRow("SELECT body FROM translations WHERE document_id=? AND block_id='p4-b12'", paper.ID).Scan(&body); err != nil {
			t.Fatal(err)
		}
		var block TranslationBlock
		if err = json.Unmarshal([]byte(body), &block); err != nil {
			t.Fatal(err)
		}
		if len(block.Sentences) != 2 || !strings.Contains(block.Sentences[1].Source, `\sum_{i=1}^{d_k}`) || !strings.Contains(block.Sentences[1].Source, `q_i k_i`) {
			t.Fatalf("dot-product source was not repaired: %+v", block)
		}
		if block.Sentences[1].Anchor != "Then their dot product, q · k = P d k q k , has mean 0 and variance d . i =1 i i k" {
			t.Fatalf("dot-product positional anchor changed: %q", block.Sentences[1].Anchor)
		}
		if block.SourceHash != "15816b813333cdf29b3b937746c13455daa8fa122c11568924b2ff8078d32ec8" || block.Status != "complete" {
			t.Fatalf("translation identity changed: %+v", block)
		}
		if restart == 0 {
			repaired = body
		} else if body != repaired {
			t.Fatal("restart changed the repaired translation")
		}
		if err = s.DB.QueryRow("SELECT body FROM translations WHERE document_id=? AND block_id='p4-b9'", paper.ID).Scan(&body); err != nil {
			t.Fatal(err)
		}
		if err = json.Unmarshal([]byte(body), &block); err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(block.Sentences[0].Source, "$") || block.Sentences[0].Anchor != "While for small values of d the two mechanisms perform similarly, additive attention outperforms k dot product attention without scaling for larger values of d [3]." {
			t.Fatalf("existing anchor was not retained: %+v", block.Sentences[0])
		}
		var after, annotation string
		if err = s.DB.QueryRow("SELECT json_array(title,progress,percentage,metadata) FROM documents WHERE id=?", paper.ID).Scan(&after); err != nil || after != before {
			t.Fatalf("document state changed: %q %v", after, err)
		}
		if err = s.DB.QueryRow("SELECT body FROM annotations WHERE id='math-note'").Scan(&annotation); err != nil || annotation != `{"kind":"highlight","text":"q · k","blockId":"p4-b12"}` {
			t.Fatalf("annotation changed: %q %v", annotation, err)
		}
		var documents, translations int
		if err = s.DB.QueryRow("SELECT count(*) FROM documents").Scan(&documents); err != nil {
			t.Fatal(err)
		}
		if err = s.DB.QueryRow("SELECT count(*) FROM translations").Scan(&translations); err != nil {
			t.Fatal(err)
		}
		if documents != 1 || translations != 122 {
			t.Fatalf("repair duplicated records: %d documents, %d translations", documents, translations)
		}
		s.DB.Close()
	}
}

func TestExampleRepairPreservesNonmatchingRecords(t *testing.T) {
	for _, scenario := range []string{
		"edited-source", "retranslated", "edited-anchor", "extra-field", "body-hash", "source-hash",
		"pending", "running", "failed", "idle", "deleted", "purged", "no-guide", "imported", "other-guide",
	} {
		t.Run(scenario, func(t *testing.T) {
			root := t.TempDir()
			s, err := OpenLibrary(root)
			if err != nil {
				t.Fatal(err)
			}
			var id string
			if err = s.DB.QueryRow("SELECT id FROM documents").Scan(&id); err != nil {
				t.Fatal(err)
			}
			body, hash, status := oldExampleDotProduct, "15816b813333cdf29b3b937746c13455daa8fa122c11568924b2ff8078d32ec8", "complete"
			switch scenario {
			case "edited-source":
				body = strings.Replace(body, "Then their dot product", "My corrected dot product", 1)
			case "retranslated":
				body = strings.Replace(body, "那么，它们的点积", "用户重译的点积", 1)
			case "edited-anchor":
				body = strings.Replace(body, `"sentences": [`, `"sentences": [{"source":"User text","target":"用户译文","anchor":"User anchor"},`, 1)
			case "extra-field":
				body = strings.Replace(body, `"status":`, `"userEdit": true, "status":`, 1)
			case "body-hash":
				body = strings.Replace(body, hash, "user-source-hash", 1)
			case "source-hash":
				hash = "user-source-hash"
			case "pending", "running", "failed", "idle":
				status = scenario
			}
			if _, err = s.DB.Exec("UPDATE translations SET body=?,source_hash=?,status=? WHERE document_id=? AND block_id='p4-b12'", body, hash, status, id); err != nil {
				t.Fatal(err)
			}
			switch scenario {
			case "deleted":
				_, err = s.DB.Exec("UPDATE documents SET deleted_at='2026-11-01' WHERE id=?", id)
			case "purged":
				_, err = s.DB.Exec("DELETE FROM documents WHERE id=?", id)
			case "no-guide":
				_, err = s.DB.Exec("DELETE FROM settings WHERE key='preferences:guide'")
			case "imported":
				_, err = s.DB.Exec(`UPDATE settings SET value='{"onboarded":true}' WHERE key='preferences:guide'`)
			case "other-guide":
				_, err = s.DB.Exec(`UPDATE settings SET value='{"exampleDocumentId":"other-paper"}' WHERE key='preferences:guide'`)
			}
			if err != nil {
				t.Fatal(err)
			}
			s.DB.Close()
			for range 2 {
				s, err = OpenLibrary(root)
				if err != nil {
					t.Fatal(err)
				}
				var documents int
				if err = s.DB.QueryRow("SELECT count(*) FROM documents").Scan(&documents); err != nil {
					t.Fatal(err)
				}
				if scenario == "purged" {
					if documents != 0 {
						t.Fatal("purged example was resurrected")
					}
				} else {
					if documents != 1 {
						t.Fatalf("document count changed: %d", documents)
					}
					var gotBody, gotHash, gotStatus, deleted string
					if err = s.DB.QueryRow("SELECT body,source_hash,status FROM translations WHERE document_id=? AND block_id='p4-b12'", id).Scan(&gotBody, &gotHash, &gotStatus); err != nil {
						t.Fatal(err)
					}
					if gotBody != body || gotHash != hash || gotStatus != status {
						t.Fatal("repair overwrote a nonmatching translation")
					}
					if err = s.DB.QueryRow("SELECT deleted_at FROM documents WHERE id=?", id).Scan(&deleted); err != nil {
						t.Fatal(err)
					}
					if scenario == "deleted" && deleted != "2026-11-01" {
						t.Fatal("repair restored a trashed document")
					}
				}
				s.DB.Close()
			}
		})
	}
}
