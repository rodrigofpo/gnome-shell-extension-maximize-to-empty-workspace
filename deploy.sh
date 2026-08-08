#!/bin/sh

NAME=MaximizeToEmptyWorkspace-extension@rodrigofpo.github.io
rm -rf ~/.local/share/gnome-shell/extensions/$NAME
cp -r $NAME ~/.local/share/gnome-shell/extensions/.
