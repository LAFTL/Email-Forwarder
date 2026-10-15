REM the rclone is uses google api to communicate between cloud and local directory.
REM line 4 - change directory to the installation of Rclone include if you are lazy.
REM Line 7 - Calling on rclone to run with the action of copying NAME_REMOTE_ID
REM line 7: --Drive-root-folder-id "FOLDER_ID" --progress <----- Do i need to explain this you muppet
REM line 11: I am so bored but okay if you need to skip rerunning the same script again and again with taks scheduler for whatever reason you can time out the bat file, /t = time 1800, /nobreak = Well yeah no break
REM line 14: uh yeah loop that shit

@echo off
cd "LOCAL_PATH_OF_RCLONE_INSTALL" 

rclone copy "NAME_REMOTE_ID" "PATH_TO_LOCATION_PATH" --drive-root-folder-id "1EV-y3AuUA5KCKOEzrI5_eWUqQhUT_bnv" --progress

timeout /t 1800 /nobreak

goto loop
