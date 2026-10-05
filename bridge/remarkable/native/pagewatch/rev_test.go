package pagewatch

import (
	"testing"
	"time"
)

func TestRevRules(t *testing.T) {
	ms := func(v int64) time.Time { return time.UnixMilli(v) }
	w := &Watcher{rev: 5000}
	cases := []struct {
		name        string
		rm          rmFile
		contentMT   int64
		pageChanged bool
		want        int64
	}{
		{"rewrite: the file's mtime", rmFile{exists: true, mt: ms(7000)}, 9000, false, 7000},
		{"rewrite never goes backwards", rmFile{exists: true, mt: ms(4000)}, 9000, false, 5000},
		{"page turn: the later of file and .content", rmFile{exists: true, mt: ms(7000)}, 9000, true, 9000},
		{"page turn to an older page may go back", rmFile{exists: true, mt: ms(3000)}, 4000, true, 4000},
		{"no file yet: the turn's time", rmFile{}, 8000, true, 8000},
	}
	for _, c := range cases {
		if got := w.revFor(Location{ContentMT: ms(c.contentMT)}, c.rm, c.pageChanged); got != c.want {
			t.Errorf("%s: rev %d, want %d", c.name, got, c.want)
		}
	}
}
