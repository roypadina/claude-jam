# README GIF. Reproduce:  bash docs/demo/demo-fixture.sh start && vhs docs/demo/demo.tape; bash docs/demo/demo-fixture.sh stop
# Records a guest ("Dana") joining a throwaway jam hosted by "Alice" with a fake claude TUI. No real data.
Output docs/demo/demo.gif
Set Shell "bash"
Set FontSize 13
Set Width 1200
Set Height 640
Set Padding 12
Set Theme "Catppuccin Mocha"
Set TypingSpeed 45ms

Hide
Type "export HOME=/private/tmp/jamdemo/home TMPDIR=/private/tmp/jamdemo/tmp PS1='$ ' && mkdir -p $HOME && clear"
Enter
Show

Type "claude-jam join ws://127.0.0.1:17777 --name Dana --token demotoken"
Sleep 400ms
Enter
Sleep 4s
Type "can you also add a retry to the webhook handler?"
Sleep 1s
Enter
Sleep 3s
Screenshot docs/demo/join.png
Type "/c Alice, is it ok to merge after this?"
Sleep 800ms
Enter
Sleep 3s
Ctrl+C
Sleep 500ms
