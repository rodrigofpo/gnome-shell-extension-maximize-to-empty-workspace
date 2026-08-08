#!/bin/sh

NAME=MaximizeToEmptyWorkspace-extension@rodrigofpo.github.io
cd $NAME
zip -r $NAME.zip *
mv $NAME.zip ../..
cd ..

